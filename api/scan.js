// ============================================================
//  scan.js — 뚱땡이 아빠의 AI 식품 안전 스캐너 (v3 최종판)
//  데이터 우선순위: ① 식품안전나라(식약처) → ② Open Food Facts → ③ 표기불가
//  영양성분 기준: 제품 전체 용량 기준 (1회 제공량 × 총 제공횟수)
// ============================================================

const FOODSAFETY_KEY = process.env.FOODSAFETY_API_KEY || "0568dde2474141e595f9";

module.exports = async (req, res) => {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "No Barcode" });

    try {
        // ══════════════════════════════════════════════════════
        //  STEP 1. 식품안전나라 API
        // ══════════════════════════════════════════════════════
        let krData = null;
        try {
            const krUrl = `http://openapi.foodsafetykorea.go.kr/api/${FOODSAFETY_KEY}/C005/json/1/5/BAR_CD=${barcode}`;
            const krRes = await fetch(krUrl, { signal: AbortSignal.timeout(4000) });
            const krJson = await krRes.json();
            if (krJson?.C005?.row?.length > 0) krData = krJson.C005.row[0];
        } catch (e) { console.log("식품안전나라 실패:", e.message); }

        // ══════════════════════════════════════════════════════
        //  STEP 2. Open Food Facts
        // ══════════════════════════════════════════════════════
        let p = null;
        try {
            const offRes = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`, { signal: AbortSignal.timeout(4000) });
            const offData = await offRes.json();
            if (offData.status === 1) p = offData.product;
        } catch (e) { console.log("OFF 실패:", e.message); }

        if (!krData && !p) {
            return res.status(200).json({ success: false, message: "DB에 아직 등록되지 않은 희귀 상품입니다 🥲" });
        }

        // ══════════════════════════════════════════════════════
        //  제품 기본 정보
        // ══════════════════════════════════════════════════════
        const rawProductName = krData?.PRDLST_NM || p?.product_name_ko || p?.product_name || "미등록 상품";
        const brandInfo      = krData?.BSSH_NM   || p?.brands || "";
        const fullName       = (brandInfo && !rawProductName.includes(brandInfo))
            ? `${brandInfo} ${rawProductName}`.trim() : rawProductName;

        // ══════════════════════════════════════════════════════
        //  원산지
        // ══════════════════════════════════════════════════════
        let originText = "제품 라벨 확인 필요";
        if (krData?.ORPLC_INFO?.trim())                         originText = krData.ORPLC_INFO.trim();
        else if (p?.origins?.trim())                            originText = p.origins.trim();
        else if (p?.countries_tags?.includes("en:south-korea")) originText = "국산 (제조국 기준)";

        // ══════════════════════════════════════════════════════
        //  원재료명
        // ══════════════════════════════════════════════════════
        let ingredients = "";
        if (krData?.RAWMTRL_NM?.trim()) ingredients = krData.RAWMTRL_NM.trim().toLowerCase();
        else if (p)                     ingredients = (p.ingredients_text_ko || p.ingredients_text || "").toLowerCase();

        // ══════════════════════════════════════════════════════
        //  ✅ 제품 전체 용량 기준 영양성분 환산 로직
        //
        //  식약처 C005는 1회 제공량(SERVING_SIZE) 기준으로 수치 제공
        //  총 제공횟수(SERVING_TOTAL) 있으면 × 총횟수 = 제품 전체 기준
        //  없으면 총 내용량(NET_WT) ÷ 1회 제공량(g) 으로 횟수 역산
        //
        //  예) 새우깡 90g, 1회 제공량 30g, 나트륨 1회 150mg
        //      → 총 제공횟수 = 90 ÷ 30 = 3회
        //      → 제품 전체 나트륨 = 150 × 3 = 450mg
        // ══════════════════════════════════════════════════════
        const parseKr   = (val) => (val && val !== "" && val !== "0") ? parseFloat(val) : null;
        const parseSize = (str) => {
            if (!str) return null;
            // "30g", "30 g", "30ml", "1개(30g)" 등 다양한 형태 처리
            const m = String(str).match(/([\d.]+)\s*(g|ml)/i);
            return m ? parseFloat(m[1]) : null;
        };

        const servingSizeRaw = krData?.SERVING_SIZE || p?.serving_size || null;  // "30g"
        const servingG       = parseSize(servingSizeRaw);                         // 30 (숫자)

        // 총 내용량: 식약처 NET_WT 우선, OFF quantity 보조
        const netWtRaw = krData?.NET_WT || p?.quantity || null;
        const netWtG   = parseSize(netWtRaw) || parseFloat(netWtRaw) || null;

        // 총 제공횟수 계산
        let totalServings = parseKr(krData?.SERVING_TOTAL) || null;
        if (!totalServings && servingG && netWtG && netWtG > servingG) {
            totalServings = Math.round(netWtG / servingG);
        }
        if (!totalServings) totalServings = 1; // 산출 불가 시 1회분 그대로

        // 1회 제공량 기준 원본 수치
        const kcalPerServing  = parseKr(krData?.NUTR_CONT1) ||
            (p?.nutriments?.["energy-kcal_serving"] ? Math.round(p.nutriments["energy-kcal_serving"]) : null);
        const fatPerServing    = parseKr(krData?.NUTR_CONT4) ||
            (p?.nutriments?.fat_100g    != null ? p.nutriments.fat_100g    * (servingG || 100) / 100 : null);
        const sugarsPerServing = parseKr(krData?.NUTR_CONT3) ||
            (p?.nutriments?.sugars_100g != null ? p.nutriments.sugars_100g * (servingG || 100) / 100 : null);
        const sodiumPerServing = parseKr(krData?.NUTR_CONT9) ||
            (p?.nutriments?.sodium_100g != null ? p.nutriments.sodium_100g * 1000 * (servingG || 100) / 100 : null);
        const carbsPerServing  = parseKr(krData?.NUTR_CONT2) || null;
        const proteinPerServing= parseKr(krData?.NUTR_CONT8) ||
            (p?.nutriments?.proteins_100g != null ? p.nutriments.proteins_100g * (servingG || 100) / 100 : null);
        const transFatPerServ  = parseKr(krData?.NUTR_CONT5) || null;
        const satFatPerServ    = parseKr(krData?.NUTR_CONT6) || null;

        // ✅ 제품 전체 기준 환산 (× 총 제공횟수)
        const toTotal = (val) => val !== null ? Math.round(val * totalServings * 10) / 10 : null;

        const kcalTotal    = toTotal(kcalPerServing);
        const fatTotal     = toTotal(fatPerServing);
        const sugarsTotal  = toTotal(sugarsPerServing);
        const sodiumTotal  = toTotal(sodiumPerServing);
        const carbsTotal   = toTotal(carbsPerServing);
        const proteinTotal = toTotal(proteinPerServing);
        const transFatTotal= toTotal(transFatPerServ);
        const satFatTotal  = toTotal(satFatPerServ);

        // ══════════════════════════════════════════════════════
        //  칼로리 표기 (제품 전체 기준)
        // ══════════════════════════════════════════════════════
        let caloriesText = "열량 정보 없음 (비공개)";
        if (kcalTotal !== null) {
            const baseStr = netWtRaw ? `${netWtRaw} 전체` : `제품 1개 전체`;
            const servStr = (kcalPerServing && totalServings > 1)
                ? ` (1회 ${servingSizeRaw || "제공량"}: ${kcalPerServing}kcal × ${totalServings}회)` : "";
            caloriesText = `${baseStr}: ${kcalTotal}kcal${servStr}`;
        }

        // ══════════════════════════════════════════════════════
        //  유해 성분 분석
        // ══════════════════════════════════════════════════════
        const warningDict = {
            "설탕":          { name: "설탕",                     risk: "과다 섭취 시 만성 염증·비만·간 손상 위험 ⚠️" },
            "sugar":         { name: "설탕",                     risk: "혈당 급상승 및 대사 증후군 유발 ⚠️" },
            "과당":          { name: "액상과당 (콘시럽)",         risk: "설탕보다 흡수 빨라 체지방(지방간) 축적 주범 🔴" },
            "물엿":          { name: "물엿/단당류",               risk: "혈당 급상승 ⚠️" },
            "수크랄로스":    { name: "수크랄로스",               risk: "인공 감미료: 장내 유익균 파괴·인슐린 저항성 악화 🔴" },
            "sucralose":     { name: "수크랄로스",               risk: "인공 감미료 🔴" },
            "아스파탐":      { name: "아스파탐",                 risk: "인공 감미료: WHO 발암가능물질 지정·신경계 교란 🔴" },
            "aspartame":     { name: "아스파탐",                 risk: "인공 감미료 🔴" },
            "사카린":        { name: "사카린나트륨",             risk: "인공 감미료: 장기 섭취 시 소화기 부작용 우려 ⚠️" },
            "아세설팜칼륨":  { name: "아세설팜칼륨",             risk: "인공 감미료: 갑상선 기능 영향 우려 ⚠️" },
            "acesulfame k":  { name: "아세설팜칼륨",             risk: "인공 감미료 ⚠️" },
            "팜유":          { name: "팜유",                     risk: "포화지방 과다 → LDL 콜레스테롤 상승 ⚠️" },
            "palm oil":      { name: "팜유",                     risk: "포화지방 과다 ⚠️" },
            "마가린":        { name: "마가린",                   risk: "트랜스지방 함유 → 혈관 벽 손상 🔴" },
            "소르빈산":      { name: "소르빈산염",               risk: "보존료: 피부 점막 자극·알레르기 유발 우려 ⚠️" },
            "아질산나트륨":  { name: "아질산나트륨",             risk: "발색제: 1급 발암물질(니트로사민) 생성 위험 🔴" },
            "안식향산나트륨":{ name: "안식향산나트륨",           risk: "보존료: 비타민C 결합 시 벤젠(1급 발암) 생성 🔴" },
            "글루탐산나트륨":{ name: "L-글루탐산나트륨 (MSG)",   risk: "향미증진제: 민감 체질 두통·발진 유발 ⚠️" },
            "msg":           { name: "MSG",                      risk: "민감 체질 부작용 우려 ⚠️" },
            "합성향료":      { name: "합성향료",                 risk: "미확인 화학물질 배합: 알레르기·두통 원인 ⚠️" },
            "타르색소":      { name: "타르색소",                 risk: "인공 착색료: 아동 ADHD·정서 불안 촉발 의심 🔴" },
            "적색40호":      { name: "적색40호",                 risk: "인공 색소: 과잉행동장애 의심 🔴" },
            "황색4호":       { name: "황색4호",                  risk: "인공 색소: 천식 알레르기 의심 🔴" }
        };

        const detectedBadObjs = [];
        Object.keys(warningDict).forEach(word => {
            if (ingredients.includes(word) && !detectedBadObjs.some(o => o.name === warningDict[word].name)) {
                detectedBadObjs.push(warningDict[word]);
            }
        });
        const uniqueBadCount = detectedBadObjs.length;
        const additives      = p?.additives_tags || [];

        // ══════════════════════════════════════════════════════
        //  점수 산정
        // ══════════════════════════════════════════════════════
        let baseScore = 100;
        const scoreBreakdown = [];
        if (additives.length > 0) {
            const p1 = additives.length * 5;
            scoreBreakdown.push(`일반 화학 첨가물 ${additives.length}개 발견 (-${p1}점)`);
            baseScore -= p1;
        }
        if (uniqueBadCount > 0) {
            const p2 = uniqueBadCount * 10;
            scoreBreakdown.push(`핵심 유해/주의성분 ${uniqueBadCount}개 발견 (-${p2}점)`);
            baseScore -= p2;
        }
        const score = Math.max(10, baseScore);

        // ══════════════════════════════════════════════════════
        //  영양소 위험도 — 제품 전체 기준 × K-FDA 1일 권장량 비율
        //  기준: 지방 54g / 당류 100g / 나트륨 2000mg (식약처 고시)
        // ══════════════════════════════════════════════════════
        const kfdaPercent = (val, dailyLimit, name) => {
            if (val === null) return { value: "?", level: "unknown", text: "정보 없음", emoji: "⚪" };
            const percent = Math.round((val / dailyLimit) * 100);
            let lvl = "green", txt = `1일 권장량의 ${percent}% (안전)`, emj = "🟢";
            if (percent >= 50)      { lvl = "red";   txt = `1일 권장량의 ${percent}% ⚠️ 위험`; emj = "🔴"; }
            else if (percent >= 25) { lvl = "amber"; txt = `1일 권장량의 ${percent}% 주의`;     emj = "🟡"; }
            const displayVal = name === "나트륨" ? `${Math.round(val)}mg` : `${Math.round(val * 10) / 10}g`;
            return { value: displayVal, level: lvl, text: txt, emoji: emj };
        };

        const macros = {
            fat:    kfdaPercent(fatTotal,    54,   "지방"),
            sugars: kfdaPercent(sugarsTotal, 100,  "당류"),
            sodium: kfdaPercent(sodiumTotal, 2000, "나트륨"),
        };

        // ══════════════════════════════════════════════════════
        //  타겟 경고 (제품 전체 기준)
        // ══════════════════════════════════════════════════════
        const targetWarnings = [];
        const isHighSugar    = sugarsTotal !== null && sugarsTotal > 25;
        const hasBadSweeteners = Object.keys(warningDict).some(
            w => ingredients.includes(w) && ["비만","혈당","당","상승"].some(r => warningDict[w].risk.includes(r))
        );
        if (isHighSugar || hasBadSweeteners)
            targetWarnings.push("🩸 당뇨/혈당 스파이크 경고 (제품 1개 당류 과다 또는 혈당 교란 감미료 발견)");
        if (sodiumTotal !== null && sodiumTotal > 1000)
            targetWarnings.push("🫀 심혈관/고혈압 주의 (제품 1개 나트륨이 1일 권장량 50% 초과)");
        const hasBadChemicals = Object.keys(warningDict).some(
            w => ingredients.includes(w) && ["발암","ADHD","벤젠","색소"].some(r => warningDict[w].risk.includes(r))
        );
        if (hasBadChemicals || ingredients.includes("카페인") || ingredients.includes("caffeine"))
            targetWarnings.push("👶 영유아/임산부 섭취 강력 제한 요망 (발암/타르색소/보존료/카페인 발견)");

        // ══════════════════════════════════════════════════════
        //  그린워싱 경고
        // ══════════════════════════════════════════════════════
        let greenwashingAlert = null;
        const fakeKeywords = ["제로","zero","라이트","light","무가당","슈가프리","슈거프리","천연","내추럴","내츄럴","natural"];
        if (fakeKeywords.some(kw => fullName.toLowerCase().includes(kw)) && uniqueBadCount > 0) {
            greenwashingAlert = "🚨 [그린워싱 주의] 마케팅은 '제로/천연'이나, 실제 유해 감미료·화학제가 발견되었습니다.";
        }

        // ══════════════════════════════════════════════════════
        //  인증
        // ══════════════════════════════════════════════════════
        const certifications = [];
        if (krData?.PRDLST_REPORT_NO) certifications.push("🛡️ 식약처 등록 제품 (보고번호 확인됨)");
        const allTextForCert = (fullName + ingredients + (p?.labels_tags || []).join(" ")).toLowerCase();
        if (allTextForCert.includes("haccp") || allTextForCert.includes("해썹")) certifications.push("식약처 HACCP 시스템 인증");
        if (allTextForCert.includes("유기농") || allTextForCert.includes("organic")) certifications.push("유기농(Organic) 인증 🌱");
        if (allTextForCert.includes("무항생제") || allTextForCert.includes("무농약")) certifications.push("무농약/무항생제 검증 🌿");

        // ══════════════════════════════════════════════════════
        //  ✅ NOVA 가공등급 — OFF 우선, 없으면 식약처 품목유형으로 자체 추정
        // ══════════════════════════════════════════════════════
        const novaDesc = {
            1: "자연 원재료 (건강식 🟢)",
            2: "기본 가공 식재료 (보통 🟡)",
            3: "가공식품 (화학첨가물 주의 🟠)",
            4: "초가공식품 (화학첨가물 다량 🔴)"
        };

        function estimateNova(krCategory, ingredients) {
            const cat = (krCategory || "").toLowerCase();
            const ing = (ingredients  || "").toLowerCase();

            // NOVA 1: 자연 원재료
            if (["신선","생과일","냉동과일","냉동채소","건조과일"].some(k => cat.includes(k))) return 1;

            // NOVA 4: 초가공식품
            const ultraCat = ["과자","라면","탄산음료","아이스크림","햄","소시지","어묵","케첩","마요네즈","스낵","캔디","초콜릿","비스킷"];
            const ultraIng = ["합성향료","타르색소","아질산","수크랄로스","아스파탐","아세설팜","안식향산","소르빈산"];
            if (ultraCat.some(k => cat.includes(k)) || ultraIng.some(k => ing.includes(k))) return 4;

            // NOVA 3: 일반 가공식품
            const procCat = ["음료","빵","면류","통조림","소스","드레싱","잼","요구르트","치즈","두부","김치","젓갈"];
            if (procCat.some(k => cat.includes(k))) return 3;

            // NOVA 2: 기본 가공 식재료
            const simpleCat = ["식용유","밀가루","설탕","소금","간장","식초","전분"];
            if (simpleCat.some(k => cat.includes(k) || ing.startsWith(k))) return 2;

            return 3; // 보수적 기본값
        }

        const krCategory = krData?.PRDLST_DCNM || "";
        const novaGroup  = p?.nova_group || estimateNova(krCategory, ingredients);
        const novaSource = p?.nova_group ? "" : " (추정)";
        const nova = `NOVA ${novaGroup} - ${novaDesc[novaGroup]}${novaSource}`;

        // ══════════════════════════════════════════════════════
        //  알레르기
        // ══════════════════════════════════════════════════════
        const allergenDict = {
            "milk": "우유", "soybeans": "대두", "wheat": "밀", "eggs": "달걀", "peanuts": "땅콩 (🔴 쇼크 위험)",
            "fish": "생선", "crustaceans": "갑각류 (🔴)", "tree nuts": "견과류", "mustard": "머스타드",
            "sesame": "참깨", "sulphites": "아황산염 (🔴 천식 주의)", "molluscs": "연체동물", "almond": "아몬드",
            "gluten": "글루텐", "soy": "콩", "pork": "돼지고기", "beef": "소고기"
        };

        let translatedAllergens = ["없음"];
        if (p?.allergens_tags?.length > 0) {
            translatedAllergens = p.allergens_tags.map(tag =>
                allergenDict[tag.replace(/en:|fr:|ko:/g, "").toLowerCase()] ||
                tag.replace(/en:|fr:|ko:/g, "").toLowerCase()
            );
        } else if (p?.allergens_from_ingredients) {
            let raw = p.allergens_from_ingredients.replace(/en:/g, "").toLowerCase();
            Object.keys(allergenDict).forEach(en => {
                raw = raw.replace(new RegExp(`\\b${en}\\b`, "gi"), allergenDict[en]);
            });
            if (raw.trim()) translatedAllergens = raw.split(",").map(s => s.trim());
        }

        // ══════════════════════════════════════════════════════
        //  최종 응답
        // ══════════════════════════════════════════════════════
        return res.status(200).json({
            success: true,
            productName:  rawProductName,
            brand:        brandInfo,
            fullName:     fullName,
            origin:       originText,
            ingredients:  krData?.RAWMTRL_NM || "",
            nutriGrade:   p?.nutriscore_grade ? p.nutriscore_grade.toUpperCase() : null,
            calories:     caloriesText,
            nova:         nova,
            macros:       macros,

            // ✅ 제품 전체 영양 상세 (index.html UI 확장용)
            nutriDetail: {
                basis:        netWtRaw ? `${netWtRaw} 전체 기준` : `제품 1개(${totalServings}회분) 전체 기준`,
                servingInfo:  (servingSizeRaw && totalServings > 1) ? `1회 제공량: ${servingSizeRaw} × ${totalServings}회` : null,
                kcal:         kcalTotal,
                carbs:        carbsTotal   !== null ? `${carbsTotal}g`          : null,
                sugars:       sugarsTotal  !== null ? `${sugarsTotal}g`         : null,
                fat:          fatTotal     !== null ? `${fatTotal}g`            : null,
                saturatedFat: satFatTotal  !== null ? `${satFatTotal}g`         : null,
                transFat:     transFatTotal !== null ? `${transFatTotal}g`      : null,
                protein:      proteinTotal !== null ? `${proteinTotal}g`        : null,
                sodium:       sodiumTotal  !== null ? `${Math.round(sodiumTotal)}mg` : null,
            },

            targetWarnings:    targetWarnings,
            greenwashingAlert: greenwashingAlert,
            certifications:    certifications,
            badIngredients: uniqueBadCount > 0
                ? detectedBadObjs
                : (additives.length > 0
                    ? [{ name: "가벼운 첨가물 일부 포함", risk: "적정 섭취 시 안전" }]
                    : [{ name: "친환경 원물", risk: "매우 안전 👍" }]),
            score:          score,
            scoreBreakdown: scoreBreakdown,
            isScraped:      false,
            allergens:      translatedAllergens,
            image:          p?.image_front_url || p?.image_url || p?.image_front_small_url || "",
            imageNutrition:  p?.image_nutrition_url    || null,
            imageIngredients: p?.image_ingredients_url || null,
            _source: krData ? "식품안전나라(식약처)" : "Open Food Facts"
        });

    } catch (error) {
        console.error("scan.js 오류:", error);
        return res.status(500).json({ success: false, message: "서버 오류가 발생했습니다." });
    }
};
