module.exports = async (req, res) => {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "No Barcode" });

    try {
        const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
        const data = await response.json();

        if (data.status === 1) {
            const p = data.product;

            let brandInfo = p.brands || "";
            let rawProductName = p.product_name_ko || p.product_name || "미등록 상품";
            let fullName = rawProductName;
            if (brandInfo && !rawProductName.includes(brandInfo)) {
                fullName = `${brandInfo} ${rawProductName}`.trim();
            }

            let additives = p.additives_tags || [];
            let ingredients = (p.ingredients_text_ko || p.ingredients_text || "").toLowerCase();
            let isScraped = false;

            // [해결책 B] 원재료명 또는 칼로리가 비어있을 경우, 네이버 웹 검색으로 고속 스크래핑
            let kcal100 = p.nutriments && p.nutriments['energy-kcal_100g'] ? Math.round(p.nutriments['energy-kcal_100g']) : null;
            let kcalServing = p.nutriments && p.nutriments['energy-kcal_serving'] ? Math.round(p.nutriments['energy-kcal_serving']) : null;

            const getNutri = (key) => (p.nutriments && p.nutriments[key] !== undefined) ? p.nutriments[key] : null;
            let fat = getNutri('fat_100g');
            let sugars = getNutri('sugars_100g');
            let sodium = getNutri('sodium_100g') !== null ? getNutri('sodium_100g') * 1000 : null; // g -> mg

            if ((!ingredients || ingredients.length < 5) || (!kcal100 && !kcalServing) || (fat === null && sugars === null && sodium === null)) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 2500);

                    // 바코드를 검색 쿼리에 강제 주입하여 영문표기(Dongwon Just 등)로 인한 한국어 검색 노이즈 완벽 차단
                    const searchQuery = barcode ? `${barcode} ${fullName} 영양성분 원산지 원재료명` : `${fullName} 영양성분 원산지 원재료명`;
                    const scrapeRes = await fetch(`https://search.naver.com/search.naver?query=${encodeURIComponent(searchQuery)}`, { signal: controller.signal });
                    clearTimeout(timeoutId);

                    let html = await scrapeRes.text();
                    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
                    let plainText = html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ');

                    // 핵심 컨텍스트 클리핑: 검색결과 전체가 아닌, 본문 내 '상품명' 주변만 추출
                    const nameParts = fullName.split(' ');
                    const keyPart = nameParts.length > 1 ? nameParts[1] : nameParts[0];
                    // HTML 헤더부(<title> 등)의 노이즈를 피하기 위해 본문이 시작되는 500번째 글자부터 탐색
                    let keywordIdx = plainText.indexOf(keyPart, 500);
                    if (keywordIdx === -1 && barcode) keywordIdx = plainText.indexOf(String(barcode), 500);

                    if (keywordIdx !== -1) {
                        plainText = plainText.substring(Math.max(0, keywordIdx - 100), keywordIdx + 800);
                    } else {
                        plainText = plainText.substring(600, 1600); // 텍스트 매칭 실패 시 상단 메뉴바(600자)를 건너뛰고 첫 블로그/쇼핑 스니펫 확보
                    }

                    const extract = (regex) => { const m = plainText.match(regex); return m ? m[1] : null; };

                    if (sugars === null) {
                        const s = extract(/당류\s*(\d+(?:\.\d+)?)\s*g/i);
                        if (s) { sugars = parseFloat(s); isScraped = true; }
                    }
                    if (fat === null) {
                        const f = extract(/지방\s*(\d+(?:\.\d+)?)\s*g/i);
                        if (f) { fat = parseFloat(f); isScraped = true; }
                    }
                    if (sodium === null) {
                        const nMatch = extract(/나트륨\s*([\d,]+(?:\.\d+)?)\s*mg/i);
                        if (nMatch) { sodium = parseFloat(nMatch.replace(/,/g, '')); isScraped = true; }
                    }

                    if (!ingredients || ingredients.length < 5) {
                        ingredients = plainText;
                        isScraped = true;
                    }
                    if (!kcal100 && !kcalServing) {
                        const kcalMatch = plainText.match(/(\d{2,4})\s*(kcal|칼로리)/i);
                        if (kcalMatch) {
                            kcalServing = parseInt(kcalMatch[1]);
                            isScraped = true;
                        }
                    }
                } catch (e) { console.log("Scraping fallback failed"); }
            }

            // 원산지(Origin) 추출 로직
            let originText = "표기 없음 (제품 라벨 참조)";
            if (p.origins) {
                originText = p.origins;
            } else {
                // 내돈내산 등 나이즈 오탐지 방지를 위한 유효 국명 화이트리스트 필터
                const validOrigins = ["국산", "국내산", "미국산", "호주산", "태국산", "중국산", "프랑스산", "스페인산", "뉴질랜드산", "칠레산", "브라질산", "독일산", "이탈리아산", "베트남산", "인도산", "캐나다산", "러시아산", "필리핀산", "말레이시아산"];
                const originMatch = ingredients.match(/([가-힣]+산)/g);
                if (originMatch) {
                    const filtered = originMatch.filter(o => validOrigins.includes(o));
                    if (filtered.length > 0) {
                        originText = filtered[0]; // 제조사 DB 한계를 대체하기 위해 최상단 핵심 원산지 1곳 확정 채택
                    }
                }

                if (originText === "표기 없음 (제품 라벨 참조)") {
                    const originKeyword = ingredients.match(/원산지\s*[:]\s*([가-힣]+)/);
                    if (originKeyword && validOrigins.includes(originKeyword[1])) {
                        originText = originKeyword[1];
                    }
                }
            }

            // 유해 성분 매핑 (강력한 필터링 및 이름/위험성 분리)
            const warningDict = {
                "설탕": { name: "설탕", risk: "과다 섭취 시 만성 염증, 비만 및 간 손상 위험 ⚠️" }, "sugar": { name: "설탕", risk: "혈당 급상승 및 대사 증후군 유발 ⚠️" },
                "과당": { name: "액상과당 (콘시럽)", risk: "설탕보다 흡수가 빨라 체지방(지방간) 축적의 주범 🔴" }, "물엿": { name: "물엿/단당류", risk: "혈당 급상승 ⚠️" },
                "수크랄로스": { name: "수크랄로스", risk: "인공 감미료: 장내 유익균 파괴, 인슐린 저항성 악화 우려 🔴" }, "sucralose": { name: "수크랄로스", risk: "인공 감미료 🔴" },
                "아스파탐": { name: "아스파탐", risk: "인공 감미료: WHO 발암가능물질 지정, 신경계 교란 및 두통 주의 🔴" }, "aspartame": { name: "아스파탐", risk: "인공 감미료 🔴" },
                "사카린": { name: "사카린나트륨", risk: "인공 감미료: 장기 섭취 시 소화기 부작용 우려 ⚠️" }, "아세설팜칼륨": { name: "아세설팜칼륨", risk: "인공 감미료: 갑상선 기능 영향 우려 ⚠️" }, "acesulfame k": { name: "아세설팜칼륨", risk: "인공 감미료 ⚠️" },
                "팜유": { name: "팜유", risk: "저가 정제유: 포화지방이 과다해 나쁜 콜레스테롤(LDL) 상승 압박 ⚠️" }, "palm oil": { name: "팜유", risk: "포화지방 과다 ⚠️" }, "마가린": { name: "마가린", risk: "트랜스지방 함유로 혈관 벽 손상 🔴" },
                "소르빈산": { name: "소르빈산염", risk: "보존료(방부제): 피부 점막 자극 및 알레르기 유발 우려 ⚠️" }, "아질산나트륨": { name: "아질산나트륨", risk: "발색제(육가공품): 고기와 결합 시 1급 발암물질(니트로사민) 생성 🔴" }, "안식향산나트륨": { name: "안식향산나트륨", risk: "보존료: 비타민C와 결합 시 1급 발암물질 '벤젠' 생성 위험 🔴" },
                "글루탐산나트륨": { name: "L-글루탐산나트륨 (MSG)", risk: "향미증진제: 일부 민감한 사람에게 두통, 메스꺼움, 피부 발진 유발 ⚠️" }, "msg": { name: "MSG", risk: "민감 체질 부작용 우려 ⚠️" },
                "합성향료": { name: "합성향료", risk: "미확인 화학물질 배합: 원인 모를 알레르기나 두통 원인 ⚠️" }, "타르색소": { name: "타르색소", risk: "인공 착색료: 아이들 주의력 결핍(ADHD) 및 정서 불안 촉발 의심 🔴" }, "적색40호": { name: "적색40호", risk: "인공 색소: 과잉행동장애 의심 🔴" }, "황색4호": { name: "황색4호", risk: "인공 색소: 천식 알레르기 의심 🔴" }
            };

            const warningKeywords = Object.keys(warningDict);
            const detectedBadObjs = [];
            warningKeywords.forEach(word => {
                if (ingredients.includes(word)) {
                    if (!detectedBadObjs.some(obj => obj.name === warningDict[word].name)) {
                        detectedBadObjs.push(warningDict[word]);
                    }
                }
            });
            const uniqueBadCount = detectedBadObjs.length;

            // 점수 산정 투명화 로직 (Score Breakdown)
            let baseScore = 100;
            const scoreBreakdown = [];

            if (additives.length > 0) {
                const addPenalty = additives.length * 5;
                scoreBreakdown.push(`일반 화학 첨가물 ${additives.length}개 발견 (-${addPenalty}점)`);
                baseScore -= addPenalty;
            }

            if (uniqueBadCount > 0) {
                const toxicPenalty = uniqueBadCount * 10;
                scoreBreakdown.push(`핵심 유해/주의성분 ${uniqueBadCount}개 발견 (-${toxicPenalty}점)`);
                baseScore -= toxicPenalty;
            }

            const score = Math.max(10, baseScore); // 최저 방어선 10점

            // 칼로리 로직 (스크래핑 연동)
            let caloriesText = "열량 정보 없음 (비공개)";
            if (kcal100 && kcalServing) caloriesText = `100g당 ${kcal100}kcal \n(1회/총 제공량: ${kcalServing}kcal)`;
            else if (kcal100) {
                const qtyMatch = p.quantity ? String(p.quantity).match(/(\d+)\s*(g|ml)/i) : null;
                if (qtyMatch) {
                    caloriesText = `100g당 ${kcal100}kcal \n(총 내용량 ${qtyMatch[1]}${qtyMatch[2].toLowerCase()}: ${Math.round(kcal100 * (parseInt(qtyMatch[1]) / 100))}kcal)`;
                } else caloriesText = `100g당 ${kcal100}kcal`;
            } else if (kcalServing) caloriesText = `총(1회) 제공량: ${kcalServing}kcal`;

            // 영양소 및 🇰🇷 식약처 1일 권장량 비율 기준 산출 (K-FDA)
            const kfdaPercent = (val, dailyLimit, name) => {
                if (val === null) return { value: '?', level: 'unknown', text: '정보 없음', emoji: '⚪' };
                const percent = Math.round((val / dailyLimit) * 100);

                let lvl = 'green', txt = `안전 (${percent}%)`, emj = '🟢';
                if (percent >= 30) { lvl = 'red'; txt = `위험 (${percent}%)`, emj = '🔴'; } // 100g당 하루치 30% 넘으면 위험
                else if (percent >= 15) { lvl = 'amber'; txt = `주의 (${percent}%)`, emj = '🟡'; }

                let displayVal = name === '나트륨' ? `${Math.round(val)}mg` : `${Math.round(val * 10) / 10}g`;
                return { value: displayVal, level: lvl, text: txt, emoji: emj };
            };

            const macros = {
                fat: kfdaPercent(fat, 54, '지방'),
                sugars: kfdaPercent(sugars, 100, '당류'),
                sodium: kfdaPercent(sodium, 2000, '나트륨')
            };

            // 타겟 맞춤형 질환 경고 모델
            const targetWarnings = [];
            const isHighSugar = sugars > 15;
            const hasBadSweeteners = warningKeywords.some(word => ingredients.includes(word) && ["비만", "혈당", "당", "상승"].some(w => warningDict[word].risk.includes(w)));
            if (isHighSugar || hasBadSweeteners) targetWarnings.push("🩸 당뇨/혈당 스파이크 경고 (당류 과다 또는 혈당 교란 감미료 발견)");
            if (sodium > 600) targetWarnings.push("🫀 심혈관/고혈압 주의 (1일 권장 나트륨 30% 이상 초과 위험 수준)");

            const hasBadChemicals = warningKeywords.some(word => ingredients.includes(word) && ["발암", "ADHD", "벤젠", "색소"].some(w => warningDict[word].risk.includes(w)));
            if (hasBadChemicals || ingredients.includes('카페인') || ingredients.includes('caffeine')) {
                targetWarnings.push("👶 영유아/임산부 섭취 강력 제한 요망 (발암/타르색소/보존료/카페인 발견)");
            }

            let greenwashingAlert = null;
            const fakeKeywords = ["제로", "zero", "라이트", "light", "무가당", "슈가프리", "슈거프리", "천연", "내추럴", "내츄럴", "natural"];
            const isMarketingFake = fakeKeywords.some(kw => fullName.toLowerCase().includes(kw));
            if (isMarketingFake && uniqueBadCount > 0) {
                greenwashingAlert = "🚨 [그린워싱 주의] 무늬만 건강식품! 마케팅은 '제로/천연'을 표방하나, 실제로는 유해 감미료나 화학제가 다량 발견되었습니다.";
            }

            const certifications = [];
            // 네이버 검색에서 긁어온 텍스트는 신뢰도가 낮으므로 유기농/HACCP 인증 검사에서 원천 제외
            const certTargetText = isScraped ? "" : ingredients;
            const allTextForCert = (fullName + certTargetText + (p.labels_tags || []).join(' ')).toLowerCase();
            if (allTextForCert.includes('haccp') || allTextForCert.includes('해썹')) certifications.push("식약처 HACCP 시스템 인증");
            if (allTextForCert.includes('유기농') || allTextForCert.includes('organic')) certifications.push("유기농(Organic) 인증 🌱");
            if (allTextForCert.includes('무항생제') || allTextForCert.includes('무농약')) certifications.push("무농약/무항생제 검증 🌿");

            const novaDesc = { 1: "자연 원재료 (건강식 🟢)", 2: "기본 가공 식재료 (보통 🟡)", 3: "가공식품 (화학첨가물 섭취 주의 🟠)", 4: "초가공식품 (정제/화학첨가물 다량 주의 🔴)" };
            const nova = p.nova_group ? `NOVA ${p.nova_group} - ${novaDesc[p.nova_group]}` : "정보 없음";

            const allergenDict = {
                "milk": "우유", "soybeans": "대두", "wheat": "밀", "eggs": "달걀", "peanuts": "땅콩 (🔴 쇼크 위험)",
                "fish": "생선", "crustaceans": "갑각류 (🔴)", "tree nuts": "견과류", "mustard": "머스타드",
                "sesame": "참깨", "sulphites": "아황산염 (🔴 천식 주의)", "molluscs": "연체동물", "almond": "아몬드",
                "gluten": "글루텐", "soy": "콩", "pork": "돼지고기", "beef": "소고기"
            };

            let translatedAllergens = ["없음"];
            if (p.allergens_tags && p.allergens_tags.length > 0) {
                translatedAllergens = p.allergens_tags.map(tag => allergenDict[tag.replace(/en:|fr:|ko:/g, '').toLowerCase()] || tag.replace(/en:|fr:|ko:/g, '').toLowerCase());
            } else if (p.allergens_from_ingredients) {
                let rawAllergens = p.allergens_from_ingredients.replace(/en:/g, '').toLowerCase();
                Object.keys(allergenDict).forEach(en => rawAllergens = rawAllergens.replace(new RegExp(`\\b${en}\\b`, 'gi'), allergenDict[en]));
                if (rawAllergens.trim() !== '') translatedAllergens = rawAllergens.split(',').map(s => s.trim());
            }

            res.status(200).json({
                success: true, productName: rawProductName, brand: brandInfo, fullName: fullName,
                nutriGrade: p.nutriscore_grade ? p.nutriscore_grade.toUpperCase() : null,
                calories: caloriesText, nova: nova, macros: macros, targetWarnings: targetWarnings,
                greenwashingAlert: greenwashingAlert, certifications: certifications,
                badIngredients: uniqueBadCount > 0 ? detectedBadObjs : (additives.length > 0 ? [{ name: '가벼운 첨가물 일부 포함', risk: '적정 섭취 시 안전' }] : [{ name: '친환경 원물', risk: '매우 안전 👍' }]),
                score: score, scoreBreakdown: scoreBreakdown, isScraped: isScraped,
                origin: originText,
                allergens: translatedAllergens,
                image: p.image_front_url || p.image_url || p.image_front_small_url || "",
                imageNutrition: p.image_nutrition_url || null,
                imageIngredients: p.image_ingredients_url || null
            });
        } else {
            res.status(200).json({ success: false, message: "Product not found" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server API Error" });
    }
};
