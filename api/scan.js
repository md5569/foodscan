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

            // 유해 성분 상세 설명 매핑
            const warningDict = {
                "설탕": "설탕 (과다 섭취 시 비만 및 간 손상 위험 ⚠️)",
                "sugar": "설탕 (혈당 급상승 및 콜레스테롤 영향 ⚠️)",
                "과당": "액상과당 (혈당을 급격히 올려 비만 유발 ⚠️)",
                "fructose": "액상과당 (혈당을 급격히 올려 비만 유발 ⚠️)",
                "팜유": "팜유 (포화지방이 콜레스테롤에 악영향을 줌 ⚠️)",
                "palm oil": "팜유 (포화지방 다중 함유, 심혈관 주의 ⚠️)",
                "착색료": "인공 착색료 (일부 알레르기나 ADHD 유발 의심 ⚠️)",
                "colorant": "인공 착색료 (소화기 장애 등 체질 보호 필요 ⚠️)",
                "감미료": "합성 감미료 (장내미생물균형 붕괴 우려 ⚠️)",
                "sweetener": "인공 감미료 (안전성 논란 및 알레르기 주의 ⚠️)",
                "보존료": "합성 보존료 (발암성 논란이 제기된 성분 포함 가능 ⚠️)",
                "preservative": "합성 보존료 (만성 질환 및 알러지 연관성 ⚠️)"
            };

            const warningKeywords = Object.keys(warningDict);
            const detectedBad = warningKeywords.filter(word => ingredients.includes(word)).map(word => warningDict[word]);
            // 중복 제거
            const uniqueBad = [...new Set(detectedBad)];

            let score = 100 - (additives.length * 5) - (uniqueBad.length * 7);
            score = Math.max(10, score);

            const brandInfo = p.brands || "알 수 없는 브랜드";
            const nutriGrade = p.nutriscore_grade ? p.nutriscore_grade.toUpperCase() : "미평가";

            const calories = (p.nutriments && p.nutriments['energy-kcal_100g']) ? `${Math.round(p.nutriments['energy-kcal_100g'])} kcal` : "정보 없음";

            const novaDesc = {
                1: "자연 원재료 (건강식 🟢)",
                2: "소금/기름 첨가된 재료 (보통 🟡)",
                3: "가공식품 (과다 섭취 주의 🟠)",
                4: "초가공식품 (섭취 주의 요망 🔴)"
            };
            const novaNum = p.nova_group;
            const nova = novaNum ? `NOVA ${novaNum} - ${novaDesc[novaNum]}` : "정보 없음";

            const allergenDict = {
                "milk": "우유 (유당불내증이나 소화장애 유발 주의)", "soybeans": "대두 (흔한 간지럼증/알레르기 원인)", "wheat": "밀 (글루텐 함유, 체강병 또는 소화불량 주의)",
                "eggs": "달걀 (아토피, 영유아 단백질 알레르기 주의)", "peanuts": "땅콩 (호흡곤란 등 치명적 아나필락시스 위험)", "fish": "생선 (비린내 등에 의한 민감반응 주의)", "crustaceans": "갑각류 (얼굴 붓기/호흡곤란 1급 알레르기)",
                "tree nuts": "견과류 (피킹 알레르기 반응)", "mustard": "머스타드 (천식 유발 가능성)", "sesame": "참깨 (중증 알레르기 빈도 증가 추세)", "sulphites": "아황산염 (천식 환자 발작 유발 위험)",
                "lupin": "루핀", "molluscs": "연체동물 (오징어, 조개 등 해산물 알러지)", "almond": "아몬드",
                "gluten": "글루텐 (염증유발 궤양이나 만성피로 영향)", "soy": "대두 (피부염 및 복통 가능성)", "pork": "돼지고기 (알레르겐 교차 반응 유발)", "beef": "소고기 (알파갈 증후군)"
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
                    rawAllergens = rawAllergens.replace(new RegExp(en, 'g'), allergenDict[en]);
                });
                if (rawAllergens.trim() !== '') {
                    translatedAllergens = rawAllergens.split(',').map(s => s.trim());
                }
            }

            res.status(200).json({
                success: true,
                productName: p.product_name_ko || p.product_name || "미등록 상품",
                brand: brandInfo,
                nutriscore: nutriGrade,
                calories: calories,
                nova: nova,
                badIngredients: uniqueBad.length > 0 ? uniqueBad : (additives.length > 0 ? ["첨가물이 일부 구성되어 있음"] : ["완전 깨끗한 친환경 건강식품입니다! 👍"]),
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
