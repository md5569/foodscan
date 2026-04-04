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

            if ((!ingredients || ingredients.length < 5) || (!kcal100 && !kcalServing)) {
                try {
                    const scrapeRes = await fetch(`https://search.naver.com/search.naver?query=${encodeURIComponent(fullName + ' 영양성분 칼로리 원재료명')}`);
                    const html = await scrapeRes.text();
                    const plainText = html.replace(/<[^>]*>?/gm, ' ');

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

            // 유해 성분 매핑 (강력한 필터링)
            const warningDict = {
                "설탕": "설탕 (비만 및 간 손상 위험 ⚠️)", "sugar": "설탕 (혈당 급상승 ⚠️)",
                "과당": "액상과당 (혈당을 급격히 올려 비만 유발 ⚠️)", "물엿": "물엿 (혈당 급상승 ⚠️)",
                "수크랄로스": "수크랄로스 (인공 감미료: 장내 유익균 파괴/혈당 교란 우려 ⚠️)", "sucralose": "수크랄로스 (인공 감미료 ⚠️)",
                "아스파탐": "아스파탐 (인공 감미료: 발암가능 및 두통 주의 ⚠️)", "aspartame": "아스파탐 (인공 감미료 ⚠️)",
                "사카린": "사카린 나트륨 (인공 감미료: 장기 섭취 시 소화기 부작용 우려 ⚠️)", "아세설팜칼륨": "아세설팜칼륨 (인공 감미료: 갑상선 영향 우려 ⚠️)", "acesulfame k": "아세설팜칼륨 (갑상선 주의 ⚠️)",
                "팜유": "팜유 (포화지방 다중 함유, 심혈관 압박 ⚠️)", "palm oil": "팜유 (콜레스테롤 상승 ⚠️)", "마가린": "마가린 (트랜스지방 ⚠️)",
                "소르빈산": "소르빈산염 (합성 보존료: 피부 점막 자극 ⚠️)", "아질산나트륨": "아질산나트륨 (햄 발색제: 1급 발암물질 생성 위험 🔴)", "안식향산나트륨": "안식향산나트륨 (보존료: 벤젠 생성 🔴)",
                "글루탐산나트륨": "L-글루탐산나트륨 (MSG: 민감한 사람에게 두통/메스꺼움 ⚠️)", "msg": "MSG (민감 체질 유발 가능 ⚠️)",
                "합성향료": "합성향료 (미확인 알레르기 유의 ⚠️)", "타르색소": "타르색소 (인공 착색료: 주의력 결핍(ADHD) 증상 유발 의심 🔴)", "적색40호": "적색40호 (인공 색소: 과잉행동장애 의심 🔴)", "황색4호": "황색4호 (천식 알레르기 의심 🔴)"
            };

            const warningKeywords = Object.keys(warningDict);
            const detectedBad = warningKeywords.filter(word => ingredients.includes(word)).map(word => warningDict[word]);
            const uniqueBad = [...new Set(detectedBad)];

            // 점수 산정 투명화 로직 (Score Breakdown)
            let baseScore = 100;
            const scoreBreakdown = [];

            if (additives.length > 0) {
                const addPenalty = additives.length * 5;
                scoreBreakdown.push(`일반 화학 첨가물 ${additives.length}개 발견 (-${addPenalty}점)`);
                baseScore -= addPenalty;
            }

            if (uniqueBad.length > 0) {
                const toxicPenalty = uniqueBad.length * 10;
                scoreBreakdown.push(`핵심 유해/주의성분 ${uniqueBad.length}개 발견 (-${toxicPenalty}점)`);
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

            // 영양소 및 🇰🇷 식약처 1일 권장량 비율 기준 (K-FDA)
            const getNutri = (key) => (p.nutriments && p.nutriments[key] !== undefined) ? p.nutriments[key] : null;
            const fat = getNutri('fat_100g');
            const sugars = getNutri('sugars_100g');
            const sodium = getNutri('sodium_100g') !== null ? getNutri('sodium_100g') * 1000 : null; // g -> mg

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
            const hasBadSweeteners = warningKeywords.some(word => ingredients.includes(word) && ["비만", "혈당", "당", "상승"].some(w => warningDict[word].includes(w)));
            if (isHighSugar || hasBadSweeteners) targetWarnings.push("🩸 당뇨/혈당 스파이크 경고 (당류 과다 또는 혈당 교란 감미료 발견)");
            if (sodium > 600) targetWarnings.push("🫀 심혈관/고혈압 주의 (1일 권장 나트륨 30% 이상 초과 위험 수준)");

            const hasBadChemicals = warningKeywords.some(word => ingredients.includes(word) && ["발암", "ADHD", "벤젠", "색소"].some(w => warningDict[word].includes(w)));
            if (hasBadChemicals || ingredients.includes('카페인') || ingredients.includes('caffeine')) {
                targetWarnings.push("👶 영유아/임산부 섭취 강력 제한 요망 (발암/타르색소/보존료/카페인 발견)");
            }

            let greenwashingAlert = null;
            const fakeKeywords = ["제로", "zero", "라이트", "light", "무가당", "슈가프리", "슈거프리", "천연", "내추럴", "내츄럴", "natural"];
            const isMarketingFake = fakeKeywords.some(kw => fullName.toLowerCase().includes(kw));
            if (isMarketingFake && uniqueBad.length > 0) {
                greenwashingAlert = "🚨 [그린워싱 주의] 무늬만 건강식품! 마케팅은 '제로/천연'을 표방하나, 실제로는 유해 감미료나 화학제가 다량 발견되었습니다.";
            }

            const certifications = [];
            const allTextForCert = (fullName + ingredients + (p.labels_tags || []).join(' ')).toLowerCase();
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
                badIngredients: uniqueBad.length > 0 ? uniqueBad : (additives.length > 0 ? ["가벼운 첨가물이 일부 구성(안전범위)"] : ["깨끗한 친환경 원료 👍"]),
                score: score, scoreBreakdown: scoreBreakdown, isScraped: isScraped,
                allergens: translatedAllergens,
                image: p.image_front_url || p.image_url || p.image_front_small_url || ""
            });
        } else {
            res.status(200).json({ success: false, message: "Product not found" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server API Error" });
    }
};
