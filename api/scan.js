export default async function handler(req, res) {
  const { barcode } = req.query;
  if (!barcode) return res.status(400).json({ success: false, message: "바코드 없음" });

  try {
    // 전 세계 오픈 식품 DB 연동 (Open Food Facts API)
    const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
    const data = await response.json();

    if (data.status === 1) {
      const p = data.product;
      // 성분 분석 로직: 첨가물(additives) 개수에 따라 100점에서 감점
      const additives = p.additives_tags || [];
      const score = Math.max(10, 100 - (additives.length * 7)); 
      
      // 알레르기 유발 물질 추출
      const allergens = p.allergens_from_ingredients || "정보 없음";

      res.status(200).json({
        success: true,
        productName: p.product_name_ko || p.product_name || "알 수 없는 상품",
        badIngredients: additives.map(a => a.split(':')[1].replace(/-/g, ' ')),
        allergens: allergens,
        score: score,
        image: p.image_front_small_url || ""
      });
    } else {
      // DB에 없는 경우
      res.status(200).json({ success: false });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "서버 통신 오류" });
  }
}
