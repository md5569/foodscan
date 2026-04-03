export default async function handler(req, res) {
  const { barcode } = req.query;
  if (!barcode) return res.status(400).json({ success: false, message: "바코드 번호가 없습니다." });

  try {
    // 전 세계 오픈 식품 DB (Open Food Facts) 실시간 호출
    const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
    const data = await response.json();

    if (data.status === 1) {
      const p = data.product;
      
      // 성분 분석 및 감점 로직 (첨가물 및 특정 키워드 기반)
      const additives = p.additives_tags || [];
      const ingredients = p.ingredients_text_ko || p.ingredients_text || "";
      
      // 주의가 필요한 한국어/영어 성분 키워드
      const warningKeywords = ["설탕", "sugar", "과당", "fructose", "팜유", "palm oil", "착색료", "colorant", "감미료", "sweetener", "보존료", "preservative"];
      const detectedBad = warningKeywords.filter(word => ingredients.toLowerCase().includes(word));
      
      // 점수 계산 (기본 100점 시작, 요소별 감점)
      let score = 100 - (additives.length * 5) - (detectedBad.length * 8);
      score = Math.max(10, score); // 최저 점수 10점 보장

      res.status(200).json({
        success: true,
        productName: p.product_name_ko || p.product_name || "알 수 없는 상품",
        badIngredients: detectedBad.length > 0 ? detectedBad : (additives.length > 0 ? ["첨가물 주의"] : ["정보 없음"]),
        score: score,
        image: p.image_front_small_url || ""
      });
    } else {
      // DB에 상품이 없는 경우
      res.status(200).json({ success: false });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "서버 통신 오류가 발생했습니다." });
  }
}
