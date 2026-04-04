module.exports = async (req, res) => {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "No Barcode" });

    try {
        const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
        const data = await response.json();

        if (data.status === 1) {
            const p = data.product;

            const additives = p.additives_tags || [];
            const ingredients = (p.ingredients_text_ko || p.ingredients_text || "").toLowerCase();

            // 깐깐한 유해 성분 상세 설명 매핑 (감미료, 보존료 등 대거 추가)
            const warningDict = {
                "설탕": "설탕 (과다 섭취 시 비만 및 간 손상 위험 ⚠️)",
                "sugar": "설탕 (혈당 급상승 및 콜레스테롤 영향 ⚠️)",
                "과당": "액상과당 (혈당을 급격히 올려 비만 유발 ⚠️)",
                "물엿": "물엿 (혈당 급상승 및 심혈관 질환 원인 ⚠️)",
                "수크랄로스": "수크랄로스 (인공 감미료: 장내 유익균 파괴 및 혈당 교란 우려 ⚠️)",
                "sucralose": "수크랄로스 (인공 감미료: 장내 미생물 파괴 주의 ⚠️)",
                "아스파탐": "아스파탐 (인공 감미료: 두통 유발 및 발암가능성 주의 ⚠️)",
                "aspartame": "아스파탐 (인공 감미료: 발암가능성 주의 ⚠️)",
                "사카린": "사카린 나트륨 (인공 감미료: 장기 섭취 시 소화기 부작용 우려 ⚠️)",
                "아세설팜칼륨": "아세설팜칼륨 (인공 감미료: 체내 분해 안 됨, 갑상선 영향 우려 ⚠️)",
                "acesulfame k": "아세설팜칼륨 (인공 감미료: 갑상선 주의 ⚠️)",
                "팜유": "팜유 (포화지방 다중 함유, 심혈관 및 콜레스테롤 압박 ⚠️)",
                "palm oil": "팜유 (포화지방에 의한 콜레스테롤 상승 ⚠️)",
                "마가린": "마가린 (트랜스지방 위험 요소 ⚠️)",
                "소르빈산": "소르빈산염 (합성 보존료: 피부 점막 자극 및 알레르기 ⚠️)",
                "아질산나트륨": "아질산나트륨 (햄/소시지 발색제: 고기 단백질과 결합 시 1급 발암물질 생성 위험 🔴)",
                "안식향산나트륨": "안식향산나트륨 (음료 보존료: 비타민C와 무리하게 만나면 벤젠 생성 🔴)",
                "글루탐산나트륨": "L-글루탐산나트륨 (MSG: 민감한 사람에게 두통이나 메스꺼움 유발 ⚠️)",
                "msg": "MSG (민감 체질에게 가슴 두근거림 등 유발 가능 ⚠️)",
                "합성향료": "합성향료 (여러 화학물질 결합체로 미확인 알레르기 유의 ⚠️)",
                "타르색소": "타르색소 (인공 착색료: 아이들 주의력 결핍(ADHD) 증상 유발 의심 🔴)",
                "적색40호": "적색40호 (인공 색소: 과잉행동장애(ADHD) 원인 지목 🔴)",
                "황색4호": "황색4호 (인공 색소: 천식 및 알레르기 유발 의심 🔴)",
                "착색료": "인공 착색료 (알레르기나 과활동성 유발 의심 ⚠️)",
                "보존료": "합성 보존료 (만성 질환 및 알러지 연관 체질 주의 ⚠️)"
            };

            const warningKeywords = Object.keys(warningDict);
            const detectedBad = warningKeywords.filter(word => ingredients.includes(word)).map(word => warningDict[word]);
            const uniqueBad = [...new Set(detectedBad)];

            let score = 100 - (additives.length * 5) - (uniqueBad.length * 7);
            score = Math.max(10, score);

            const brandInfo = p.brands || "";
            const rawProductName = p.product_name_ko || p.product_name || "미등록 상품";

            // FULL NAME 검색을 위해 제조사 + 상품명 결합 ("JUST" + "스위트콘" = "JUST 스위트콘")
            let fullName = rawProductName;
            if (brandInfo && !rawProductName.includes(brandInfo)) {
                fullName = `${brandInfo} ${rawProductName}`.trim();
            }

            const nutriGrade = p.nutriscore_grade ? p.nutriscore_grade.toUpperCase() : "미평가";

            // 칼로리 듀얼 렌더링 (100g 당 / 총 제공량)
            const kcal100 = p.nutriments && p.nutriments['energy-kcal_100g'] ? Math.round(p.nutriments['energy-kcal_100g']) : null;
            const kcalServing = p.nutriments && p.nutriments['energy-kcal_serving'] ? Math.round(p.nutriments['energy-kcal_serving']) : null;
            let caloriesText = "정보 없음";
            if (kcal100 && kcalServing) {
                caloriesText = `100g당 ${kcal100}kcal \n(1회 제공량: ${kcalServing}kcal)`;
            } else if (kcal100) {
                // 총 중량이 있는경우 총 칼로리 계산
                const qtyMatch = p.quantity ? String(p.quantity).match(/(\d+)\s*(g|ml)/i) : null;
                if (qtyMatch) {
                    const totalQty = parseInt(qtyMatch[1]);
                    const totalKcal = Math.round(kcal100 * (totalQty / 100));
                    caloriesText = `100g당 ${kcal100}kcal \n(총 내용량 ${totalQty}${qtyMatch[2].toLowerCase()}: ${totalKcal}kcal)`;
                } else {
                    caloriesText = `100g당 ${kcal100}kcal`;
                }
            } else if (kcalServing) {
                caloriesText = `1회 제공량 ${kcalServing}kcal`;
            }

            const novaDesc = {
                1: "자연 원재료 (건강식 🟢)",
                2: "기본 가공 식재료 (보통 🟡)",
                3: "가공식품 (화학첨가물 섭취 주의 🟠)",
                4: "초가공식품 (정제/화학첨가물 다량, 섭취 주의 요망 🔴)"
            };
            const novaNum = p.nova_group;
            const nova = novaNum ? `NOVA ${novaNum} - ${novaDesc[novaNum]}` : "정보 없음";

            const allergenDict = {
                "milk": "우유 (유당불내증이나 복통/설사 유발 주의)", "soybeans": "대두 (흔한 간지럼증/알레르기 주요 원인)", "wheat": "밀 (글루텐 함유, 체강병 또는 소화불량 주의)",
                "eggs": "달걀 (아토피, 영유아 단백질 알레르기 주의)", "peanuts": "땅콩 (호흡곤란 등 치명적 아나필락시스 쇼크 위험 🔴)", "fish": "생선 (비린내 등에 의한 민감반응 주의)", "crustaceans": "갑각류 (얼굴 붓기/호흡곤란 1급 알레르기 🔴)",
                "tree nuts": "견과류 (피부 두드러기 및 호흡 알레르기)", "mustard": "머스타드 (천식 발작 유발 가능성)", "sesame": "참깨 (중증 알레르기 빈도 증가 추세)", "sulphites": "아황산염 (천식 환자 호흡곤란/발작 유발 위험 🔴)",
                "molluscs": "연체동물 (오징어, 조개 등 해산물 알러지)", "almond": "아몬드",
                "gluten": "글루텐 (염증유발 궤양이나 만성피로 원인 의심)", "soy": "대두 (콩 단백질 민감 반응)", "pork": "돼지고기 (특정 항체 교차 반응 유발)", "beef": "소고기 (알파갈 증후군 등 식육 알레르기 주의)"
            };

            let translatedAllergens = ["없음"];
            if (p.allergens_tags && p.allergens_tags.length > 0) {
                translatedAllergens = p.allergens_tags.map(tag => {
                    const cleanTag = tag.replace(/en:|fr:|ko:/g, '').toLowerCase();
                    return allergenDict[cleanTag] || cleanTag;
                });
            } else if (p.allergens_from_ingredients) {
                let rawAllergens = p.allergens_from_ingredients.replace(/en:/g, '').toLowerCase();
                Object.keys(allergenDict).forEach(en => {
                    rawAllergens = rawAllergens.replace(new RegExp(`\\b${en}\\b`, 'gi'), allergenDict[en]); // 단어 단위로 정확히 치환
                });
                if (rawAllergens.trim() !== '') {
                    translatedAllergens = rawAllergens.split(',').map(s => s.trim());
                }
            }

            res.status(200).json({
                success: true,
                productName: rawProductName,
                brand: brandInfo,
                fullName: fullName,
                nutriscore: nutriGrade,
                calories: caloriesText,
                nova: nova,
                badIngredients: uniqueBad.length > 0 ? uniqueBad : (additives.length > 0 ? ["첨가물이 일부 구성되어 있음 (안전범위 내)"] : ["완전 깨끗한 친환경 원료입니다! 👍"]),
                score: score,
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
