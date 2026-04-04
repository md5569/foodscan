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

            // Extract brand and nutriscore
            const brandInfo = p.brands || "알 수 없는 브랜드";
            const nutriGrade = p.nutriscore_grade ? p.nutriscore_grade.toUpperCase() : "평가 안됨";

            res.status(200).json({
                success: true,
                productName: p.product_name_ko || p.product_name || "미등록 외국 상품",
                brand: brandInfo,
                nutriscore: nutriGrade,
                badIngredients: detectedBad.length > 0 ? detectedBad : (additives.length > 0 ? ["첨가물 주의"] : ["없음"]),
                score: score,
                allergens: p.allergens_from_ingredients ? p.allergens_from_ingredients.replace(/en:/g, '') : "없음",
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
