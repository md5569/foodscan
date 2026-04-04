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
            const warningKeywords = ["설탕", "sugar", "과당", "fructose", "팜유", "palm oil", "착색료", "colorant", "감미료", "sweetener", "보존료", "preservative"];
            const detectedBad = warningKeywords.filter(word => ingredients.includes(word));

            let score = 100 - (additives.length * 5) - (detectedBad.length * 7);
            score = Math.max(10, score);

            const brandInfo = p.brands || "알 수 없는 브랜드";
            const nutriGrade = p.nutriscore_grade ? p.nutriscore_grade.toUpperCase() : "평가 안됨";

            // 알레르기 영문-한글 번역 매핑
            const allergenDict = {
                "milk": "우유", "soybeans": "대두", "wheat": "밀", "eggs": "달걀", "peanuts": "땅콩", "fish": "생선", "crustaceans": "갑각류",
                "tree nuts": "견과류", "mustard": "머스타드", "sesame": "참깨", "sulphites": "아황산염", "lupin": "루핀", "molluscs": "연체동물",
                "gluten": "글루텐", "soy": "대두", "oats": "귀리", "celery": "셀러리", "buckwheat": "메밀", "pork": "돼지고기", "beef": "소고기",
                "chicken": "닭고기", "peach": "복숭아", "tomato": "토마토", "walnut": "호두", "almond": "아몬드"
            };

            let translatedAllergens = "없음";
            if (p.allergens_tags && p.allergens_tags.length > 0) {
                translatedAllergens = p.allergens_tags.map(tag => {
                    const cleanTag = tag.replace(/en:|fr:|ko:/g, '').toLowerCase();
                    return allergenDict[cleanTag] || cleanTag; // 사전에 없으면 영문 그대로 표기
                }).join(', ');
            } else if (p.allergens_from_ingredients) {
                let rawAllergens = p.allergens_from_ingredients.replace(/en:/g, '').toLowerCase();
                Object.keys(allergenDict).forEach(en => {
                    rawAllergens = rawAllergens.replace(new RegExp(en, 'g'), allergenDict[en]);
                });
                translatedAllergens = rawAllergens || "없음";
            }

            res.status(200).json({
                success: true,
                productName: p.product_name_ko || p.product_name || "미등록 상품 (DB 없음)",
                brand: brandInfo,
                nutriscore: nutriGrade,
                badIngredients: detectedBad.length > 0 ? detectedBad : (additives.length > 0 ? ["첨가물 주의"] : ["건강한 식품입니다 유해성분 없음"]),
                score: score,
                allergens: translatedAllergens,
                image: p.image_front_small_url || ""
            });
        } else {
            res.status(200).json({ success: false, message: "Product not found" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server API Error" });
    }
};
