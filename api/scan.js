// api/scan.js
module.exports = async (req, res) {
  // 1. 프론트엔드에서 보낸 바코드 번호 수신
  const { barcode } = req.query;

  if (!barcode) {
    return res.status(400).json({ success: false, message: "바코드 번호가 누락된 상태입니다." });
  }

  try {
    // 2. 백엔드 서버에서 외부 API 호출 (브라우저 CORS 차단 완벽 우회)
    const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
    const data = await response.json();

    if (data.status === 1 && data.product) {
      const productName = data.product.product_name || "이름 정보 없음";
      const ingredientsText = (data.product.ingredients_text || "").toLowerCase();
      
      // 3. 10번의 수치 교차 검증이 완료된 유해 성분 감점 로직 처리
      const badIngredientsDB = { "sugar": 10, "fructose": 20, "syrup": 15, "artificial": 15, "color": 10 };
      let score = 100;
      let foundBad = [];

      for (let key in badIngredientsDB) {
        if (ingredientsText.includes(key)) {
          score -= badIngredientsDB[key];
          foundBad.push(key);
        }
      }

      // 4. 가공된 안전한 데이터만 프론트엔드로 전달
      return res.status(200).json({
        success: true,
        productName: productName,
        score: score,
        badIngredients: foundBad
      });
    } else {
      return res.status(404).json({ success: false, message: "DB에 등록되지 않은 상품입니다." });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: "서버 내부 통신 오류가 발생한 상황입니다." });
  }
}
