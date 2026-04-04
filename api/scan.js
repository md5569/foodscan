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

            // 유해 성분 매핑
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

            let score = 100 - (additives.length * 5) - (uniqueBad.length * 7);
            score = Math.max(10, score);

            let brandInfo = p.brands || "";
            let rawProductName = p.product_name_ko || p.product_name || "미등록 상품";
            let fullName = rawProductName;
            if (brandInfo && !rawProductName.includes(brandInfo)) {
                fullName = `${brandInfo} ${rawProductName}`.trim();
            }

            // 칼로리 로직
            const kcal100 = p.nutriments && p.nutriments['energy-kcal_100g'] ? Math.round(p.nutriments['energy-kcal_100g']) : null;
            const kcalServing = p.nutriments && p.nutriments['energy-kcal_serving'] ? Math.round(p.nutriments['energy-kcal_serving']) : null;
            let caloriesText = "비공개";
            if (kcal100 && kcalServing) caloriesText = `100g당 ${kcal100}kcal \n(1회 제공량: ${kcalServing}kcal)`;
            else if (kcal100) {
                const qtyMatch = p.quantity ? String(p.quantity).match(/(\d+)\s*(g|ml)/i) : null;
                if (qtyMatch) {
                    caloriesText = `100g당 ${kcal100}kcal \n(총 내용량 ${qtyMatch[1]}${qtyMatch[2].toLowerCase()}: ${Math.round(kcal100 * (parseInt(qtyMatch[1]) / 100))}kcal)`;
                } else caloriesText = `100g당 ${kcal100}kcal`;
            } else if (kcalServing) caloriesText = `1회 제공량 ${kcalServing}kcal`;

            // 영양소 및 신호등 로직 (UK FSA 기반)
            const getNutri = (key) => (p.nutriments && p.nutriments[key] !== undefined) ? p.nutriments[key] : null;
            const carbs = getNutri('carbohydrates_100g');
            const proteins = getNutri('proteins_100g');
            const fat = getNutri('fat_100g');
            const sugars = getNutri('sugars_100g');
            const sodium = getNutri('sodium_100g');

            const trafficLight = (val, thRed, thAmber, name, unit = 'g') => {
                if (val === null) return { value: '?', level: 'unknown', text: '정보 없음', emoji: '⚪' };
                let lvl = 'green', txt = '안전 수준', emj = '🟢';
                if (val > thRed) { lvl = 'red'; txt = '위험 수준'; emj = '🔴'; }
                else if (val > thAmber) { lvl = 'amber'; txt = '경고 수준'; emj = '🟡'; }
                return { value: `${Math.round(val * 10) / 10}${unit}`, level: lvl, text: txt, emoji: emj };
            };

            const macros = {
                carbs: carbs !== null ? `${Math.round(carbs)}g` : '?',
                proteins: proteins !== null ? `${Math.round(proteins)}g` : '?',
                fat: trafficLight(fat, 20, 3, '지방'),
                sugars: trafficLight(sugars, 22.5, 5, '당류'),
                sodium: trafficLight(sodium, 0.6, 0.12, '나트륨') // 0.6g Na = 1.5g Salt
            };

            // 타겟 맞춤형 질환 경고 모델
            const targetWarnings = [];
            const isHighSugar = sugars > 15;
            const hasBadSweeteners = Object.keys(warningDict).some(word => ingredients.includes(word) && ["비만", "혈당", "당", "상승"].some(w => warningDict[word].includes(w)));
            if (isHighSugar || hasBadSweeteners) targetWarnings.push("🩸 당뇨/혈당 스파이크 경고 (당류 과다 또는 혈당 교란/인공 감미료 포함)");

            if (sodium > 0.6) targetWarnings.push("🫀 심혈관/고혈압 주의 (1일 권장 나트륨 초과 위험 수준)");

            const hasBadChemicals = Object.keys(warningDict).some(word => ingredients.includes(word) && ["발암", "ADHD", "벤젠", "색소"].some(w => warningDict[word].includes(w)));
            if (hasBadChemicals || ingredients.includes('카페인') || ingredients.includes('caffeine')) {
                targetWarnings.push("👶 영유아/임산부 섭취 강력 제한 요망 (발암/타르색소/합성보존료/카페인 등 발견)");
            }

            const novaDesc = { 1: "자연 원재료 (건강식 🟢)", 2: "기본 가공 식재료 (보통 🟡)", 3: "가공식품 (화학첨가물 섭취 주의 🟠)", 4: "초가공식품 (정제/화학첨가물 다량 주의 🔴)" };
            const nova = p.nova_group ? `NOVA ${p.nova_group} - ${novaDesc[p.nova_group]}` : "정보 없음";

            const allergenDict = {
                "milk": "우유 (유당불내증/복통 유발)", "soybeans": "대두 (알레르기 원인)", "wheat": "밀 (글루텐 함유, 체강병 주의)",
                "eggs": "달걀 (단백질 알레르기)", "peanuts": "땅콩 (호흡곤란 아나필락시스 위험 🔴)", "fish": "생선 (민감반응 주의)", "crustaceans": "갑각류 (얼굴 붓기/호흡곤란 🔴)",
                "tree nuts": "견과류", "mustard": "머스타드", "sesame": "참깨", "sulphites": "아황산염 (천식 발작 위험 🔴)",
                "molluscs": "연체동물", "almond": "아몬드", "gluten": "글루텐", "soy": "콩 단백질", "pork": "돼지고기", "beef": "소고기"
            };

            let translatedAllergens = ["없음"];
            if (p.allergens_tags && p.allergens_tags.length > 0) {
                translatedAllergens = p.allergens_tags.map(tag => allergenDict[tag.replace(/en:|fr:|ko:/g, '').toLowerCase()] || tag.replace(/en:|fr:|ko:/g, '').toLowerCase());
            } else if (p.allergens_from_ingredients) {
                let rawAllergens = p.allergens_from_ingredients.replace(/en:/g, '').toLowerCase();
                Object.keys(allergenDict).forEach(en => rawAllergens = rawAllergens.replace(new RegExp(`\\b${en}\\b`, 'gi'), allergenDict[en]));
                if (rawAllergens.trim() !== '') translatedAllergens = rawAllergens.split(',').map(s => s.trim());
            }

            let frequencyGuide = "";
            if (score >= 80) frequencyGuide = "전 세계 영양학 기준 상위 등급! 매일 식단에 포함시켜도 안심할 수 있는 건강한 성분입니다. 👨‍⚕️🟢";
            else if (score >= 60) frequencyGuide = "보통 수준의 가공식품입니다. 화학 첨가물이 일부 포함되어 있으므로 **주 2~3회 이내**로 조절해 드시는 것을 권장합니다. 🟡";
            else if (score >= 40) frequencyGuide = "주의! 첨가물과 설탕/나트륨 비율이 높은 초가공식품일 확률이 높습니다. 가급적 **주 1회 이하**의 특식으로만 양보하세요. 🟠";
            else frequencyGuide = "경고! WHO 기준 체내 염증을 유발할 수 있는 다량의 화학성분(발색제, 감미료 등)이 포함되어 있습니다. 가급적 **월 1~2회 미만** 섭취를 강력히 안내합니다. 🔴";

            let fallbackName = (rawProductName + " " + ingredients).toLowerCase();
            let alternative = null;
            if (fallbackName.includes('콜라') || fallbackName.includes('음료')) alternative = { keyword: "제로 콤부차", text: "설탕 덩어리 음료 대신 유산균이 풍부한 '무가당 콤부차'나 '탄산수'는 어떠세요?" };
            else if (fallbackName.includes('라면') || fallbackName.includes('noodle')) alternative = { keyword: "건면 라면", text: "기름에 튀긴 면 대신 트랜스지방을 뺀 '건면' 또는 '두부면'을 추천합니다!" };
            else if (fallbackName.includes('과자') || fallbackName.includes('snack')) alternative = { keyword: "통밀 크래커", text: "화학조미료 범벅 과자 대신 식이섬유가 풍부한 '통밀 크래커'가 좋습니다!" };
            else if (fallbackName.includes('소시지') || fallbackName.includes('햄')) alternative = { keyword: "무항생제 무첨가 햄", text: "발암물질(아질산나트륨)이 없는 '무첨가 수제 햄'이 안전합니다!" };
            else if (fallbackName.includes('아이스크림')) alternative = { keyword: "저칼로리 아이스크림", text: "당류가 폭발하는 일반 아이스크림 대신 '알룰로스 아이스크림'을 드셔보세요!" };
            else if (score < 70) alternative = { keyword: "유기농 과자", text: "화학 첨가물이 너무 많아요! '유기농 자연 원물식품'으로 교체하는 것은 어떨까요?" };

            res.status(200).json({
                success: true, productName: rawProductName, brand: brandInfo, fullName: fullName,
                nutriGrade: p.nutriscore_grade ? p.nutriscore_grade.toUpperCase() : null, // A, B, C, D, E
                calories: caloriesText, nova: nova, macros: macros, targetWarnings: targetWarnings,
                badIngredients: uniqueBad.length > 0 ? uniqueBad : (additives.length > 0 ? ["첨가물이 일부 구성(안전범위)"] : ["깨끗한 친환경 원료 👍"]),
                score: score, allergens: translatedAllergens,
                image: p.image_front_url || p.image_url || p.image_front_small_url || "",
                guide: frequencyGuide, alternative: alternative
            });
        } else {
            res.status(200).json({ success: false, message: "Product not found" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server API Error" });
    }
};
