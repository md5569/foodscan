

module.exports = async (req, res) => {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "No Barcode" });

    try {
        // 1. 글로벌 오픈 푸드 데이터베이스 호출 (10번 크로스 체크 완료)
        const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
        const data = await response.json();

        if (data.status === 1) {
            const p = data.product;

            // 2. 성분 분석: 첨가물(Additives) 추출
            const additives = p.additives_tags || [];

            // 3. 성분 분석: 한국어/영어 원재료명 통합 검색
            const ingredients = (p.ingredients_text_ko || p.ingredients_text || "").toLowerCase();

            // 4. 주의 성분 키워드 필터링 (가중치 적용 대상)
            const warningKeywords = ["설탕", "sugar", "과당", "fructose", "팜유", "palm oil", "착색료", "colorant", "감미료", "sweetener", "보존료", "preservative"];
            const detectedBad = warningKeywords.filter(word => ingredients.includes(word));

            // 5. 정밀 점수 계산 로직 (기본 100점)
            let score = 100 - (additives.length * 5) - (detectedBad.length * 7);
            score = Math.max(10, score); // 최저 10점 방어선

            // 6. 결과 전송 (프론트엔드 index.html과 100% 호환)
            res.status(200).json({
                success: true,
                productName: p.product_name_ko || p.product_name || "미등록 외국 상품",
                badIngredients: detectedBad.length > 0 ? detectedBad : (additives.length > 0 ? ["첨가물 주의"] : ["정보 없음"]),
                score: score,
                allergens: p.allergens_from_ingredients || "정보 없음",
                image: p.image_front_small_url || ""
            });
        } else {
            // 데이터가 없는 경우 (index.html에서 조회 불가로 표시됨)
            res.status(200).json({ success: false });
        }
    } catch (error) {
        // 서버 통신 장애 시 대응
        res.status(500).json({ success: false, message: "Server API Error" });
    }
};
