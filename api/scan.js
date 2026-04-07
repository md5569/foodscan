// ============================================================
//  scan.js — 뚱땡이 아빠의 AI 식품 안전 스캐너 (리팩터링 완전판)
//  데이터 우선순위: ① 식품안전나라(식약처) → ② Open Food Facts → ③ 표기불가
// ============================================================

const FOODSAFETY_KEY = process.env.FOODSAFETY_API_KEY; // 식품안전나라 인증키

module.exports = async (req, res) => {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "No Barcode" });

    try {
        // ══════════════════════════════════════════════════════
        //  STEP 1. 식품안전나라 API (한국 제품 핵심 — 원산지/원재료 정확도 최강)
        //  서비스: C005 (식품영양성분 바코드 검색)
        // ══════════════════════════════════════════════════════
        let krData = null;
        try {
            const krUrl = `http://openapi.foodsafetykorea.go.kr/api/${FOODSAFETY_KEY}/C005/json/1/5/BAR_CD=${barcode}`;
            const krRes = await fetch(krUrl, { signal: AbortSignal.timeout(4000) });
            const krJson = await krRes.json();
            if (krJson?.C005?.row?.length > 0) {
                krData = krJson.C005.row[0];
            }
        } catch (e) {
            console.log("식품안전나라 C005 API 실패:", e.message);
        }

        // ══════════════════════════════════════════════════════
        //  STEP 2. Open Food Facts (글로벌 DB — 수입품/영양성분 강점)
        // ══════════════════════════════════════════════════════
        let p = null;
        try {
            const offRes = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`, { signal: AbortSignal.timeout(4000) });
            const offData = await offRes.json();
            if (offData.status === 1) p = offData.product;
        } catch (e) {
            console.log("Open Food Facts API 실패:", e.message);
        }

        // 둘 다 실패 시 조기 종료
        if (!krData && !p) {
            return res.status(200).json({ success: false, message: "DB에 아직 등록되지 않은 희귀 상품입니다 🥲" });
        }

        // ══════════════════════════════════════════════════════
        //  제품 기본 정보 병합 (식약처 우선)
        // ══════════════════════════════════════════════════════
        const rawProductName =
            krData?.PRDLST_NM ||                     // 식약처: 제품명
            p?.product_name_ko ||
            p?.product_name ||
            "미등록 상품";

        const brandInfo =
            krData?.BSSH_NM ||                        // 식약처: 업체명(브랜드)
            p?.brands ||
            "";

        const fullName = (brandInfo && !rawProductName.includes(brandInfo))
            ? `${brandInfo} ${rawProductName}`.trim()
            : rawProductName;

        // ══════════════════════════════════════════════════════
        //  원산지 — 식약처 ORPLC_INFO 필드 직접 사용 (가장 정확)
        // ══════════════════════════════════════════════════════
        let originText = "제품 라벨 확인 필요";

        if (krData?.ORPLC_INFO && krData.ORPLC_INFO.trim() !== "") {
            // 예: "국산(밀,대두), 미국산(옥수수전분)" — 식약처 공식 표기 그대로 사용
            originText = krData.ORPLC_INFO.trim();
        } else if (p?.origins && p.origins.trim() !== "") {
            originText = p.origins.trim();
        } else if (p?.countries_tags?.includes("en:south-korea")) {
            originText = "국산 (제조국 기준)";
        }

        // ══════════════════════════════════════════════════════
        //  원재료명 — 식약처 RAWMTRL_NM 필드 직접 사용
        // ══════════════════════════════════════════════════════
        let ingredients = "";

        if (krData?.RAWMTRL_NM && krData.RAWMTRL_NM.trim() !== "") {
            // 식약처 공식 원재료명 — 가장 정확, 스크래핑 불필요
            ingredients = krData.RAWMTRL_NM.trim().toLowerCase();
        } else if (p) {
            ingredients = (p.ingredients_text_ko || p.ingredients_text || "").toLowerCase();
        }

        // ══════════════════════════════════════════════════════
        //  영양성분 — 식약처 or OFF 병합 (식약처 우선)
        // ══════════════════════════════════════════════════════
        // 식약처 C005 영양 필드: NUTR_CONT1=열량, NUTR_CONT2=탄수화물, NUTR_CONT3=당류
        //                        NUTR_CONT4=지방, NUTR_CONT5=트랜스지방, NUTR_CONT6=포화지방
        //                        NUTR_CONT7=콜레스테롤, NUTR_CONT8=단백질, NUTR_CONT9=나트륨
        // 단위: 1회제공량(SERVING_SIZE) 기준

        const parseKr = (val) => (val && val !== "" && val !== "0") ? parseFloat(val) : null;

        let kcalServing = parseKr(krData?.NUTR_CONT1) ||
            (p?.nutriments?.["energy-kcal_serving"] ? Math.round(p.nutriments["energy-kcal_serving"]) : null);

        let kcal100 = (p?.nutriments?.["energy-kcal_100g"]) ? Math.round(p.nutriments["energy-kcal_100g"]) : null;

        let fat = parseKr(krData?.NUTR_CONT4) ||
            (p?.nutriments?.fat_100g ?? null);

        let sugars = parseKr(krData?.NUTR_CONT3) ||
            (p?.nutriments?.sugars_100g ?? null);

        // 식약처 나트륨: mg 단위 직접 제공 (OFF는 g → ×1000 변환 필요)
        let sodium = parseKr(krData?.NUTR_CONT9) ||
            (p?.nutriments?.sodium_100g != null ? p.nutriments.sodium_100g * 1000 : null);

        const servingSize = krData?.SERVING_SIZE || p?.serving_size || null;
        const additives = p?.additives_tags || [];
        const isScraped = false; // 식약처 직접 조회 → 스크래핑 불필요

        // ══════════════════════════════════════════════════════
        //  유해 성분 분석 (warningDict 기존 유지)
        // ══════════════════════════════════════════════════════
        const warningDict = {
            "설탕": { name: "설탕", risk: "과다 섭취 시 만성 염증, 비만 및 간 손상 위험 ⚠️" },
            "sugar": { name: "설탕", risk: "혈당 급상승 및 대사 증후군 유발 ⚠️" },
            "과당": { name: "액상과당 (콘시럽)", risk: "설탕보다 흡수가 빨라 체지방(지방간) 축적의 주범 🔴" },
            "물엿": { name: "물엿/단당류", risk: "혈당 급상승 ⚠️" },
            "수크랄로스": { name: "수크랄로스", risk: "인공 감미료: 장내 유익균 파괴, 인슐린 저항성 악화 우려 🔴" },
            "sucralose": { name: "수크랄로스", risk: "인공 감미료 🔴" },
            "아스파탐": { name: "아스파탐", risk: "인공 감미료: WHO 발암가능물질 지정, 신경계 교란 주의 🔴" },
            "aspartame": { name: "아스파탐", risk: "인공 감미료 🔴" },
            "사카린": { name: "사카린나트륨", risk: "인공 감미료: 장기 섭취 시 소화기 부작용 우려 ⚠️" },
            "아세설팜칼륨": { name: "아세설팜칼륨", risk: "인공 감미료: 갑상선 기능 영향 우려 ⚠️" },
            "acesulfame k": { name: "아세설팜칼륨", risk: "인공 감미료 ⚠️" },
            "팜유": { name: "팜유", risk: "포화지방 과다 → 나쁜 콜레스테롤(LDL) 상승 ⚠️" },
            "palm oil": { name: "팜유", risk: "포화지방 과다 ⚠️" },
            "마가린": { name: "마가린", risk: "트랜스지방 함유로 혈관 벽 손상 🔴" },
            "소르빈산": { name: "소르빈산염", risk: "보존료(방부제): 피부 점막 자극 및 알레르기 유발 우려 ⚠️" },
            "아질산나트륨": { name: "아질산나트륨", risk: "발색제: 1급 발암물질(니트로사민) 생성 위험 🔴" },
            "안식향산나트륨": { name: "안식향산나트륨", risk: "보존료: 비타민C와 결합 시 벤젠(1급 발암) 생성 위험 🔴" },
            "글루탐산나트륨": { name: "L-글루탐산나트륨 (MSG)", risk: "향미증진제: 민감 체질 두통·발진 유발 ⚠️" },
            "msg": { name: "MSG", risk: "민감 체질 부작용 우려 ⚠️" },
            "합성향료": { name: "합성향료", risk: "미확인 화학물질 배합: 알레르기·두통 원인 ⚠️" },
            "타르색소": { name: "타르색소", risk: "인공 착색료: 아동 ADHD 및 정서 불안 촉발 의심 🔴" },
            "적색40호": { name: "적색40호", risk: "인공 색소: 과잉행동장애 의심 🔴" },
            "황색4호": { name: "황색4호", risk: "인공 색소: 천식 알레르기 의심 🔴" }
        };

        const detectedBadObjs = [];
        Object.keys(warningDict).forEach(word => {
            if (ingredients.includes(word)) {
                if (!detectedBadObjs.some(obj => obj.name === warningDict[word].name)) {
                    detectedBadObjs.push(warningDict[word]);
                }
            }
        });
        const uniqueBadCount = detectedBadObjs.length;

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
        //  칼로리 표기
        // ══════════════════════════════════════════════════════
        let caloriesText = "열량 정보 없음 (비공개)";
        const svStr = servingSize ? ` / 1회 제공량: ${servingSize}` : "";

        if (kcalServing && kcal100) {
            caloriesText = `100g당 ${kcal100}kcal (1회 ${servingSize || "제공량"}: ${kcalServing}kcal)`;
        } else if (kcalServing) {
            caloriesText = `1회 제공량(${servingSize || "기준"}): ${kcalServing}kcal`;
        } else if (kcal100) {
            caloriesText = `100g당 ${kcal100}kcal${svStr}`;
        }

        // ══════════════════════════════════════════════════════
        //  영양소 등급 (K-FDA 1일 권장량 기준)
        // ══════════════════════════════════════════════════════
        const kfdaPercent = (val, dailyLimit, name) => {
            if (val === null) return { value: "?", level: "unknown", text: "정보 없음", emoji: "⚪" };
            const percent = Math.round((val / dailyLimit) * 100);
            let lvl = "green", txt = `안전 (${percent}%)`, emj = "🟢";
            if (percent >= 30) { lvl = "red"; txt = `위험 (${percent}%)`; emj = "🔴"; }
            else if (percent >= 15) { lvl = "amber"; txt = `주의 (${percent}%)`; emj = "🟡"; }
            const displayVal = name === "나트륨" ? `${Math.round(val)}mg` : `${Math.round(val * 10) / 10}g`;
            return { value: displayVal, level: lvl, text: txt, emoji: emj };
        };

        const macros = {
            fat: kfdaPercent(fat, 54, "지방"),
            sugars: kfdaPercent(sugars, 100, "당류"),
            sodium: kfdaPercent(sodium, 2000, "나트륨")
        };

        // ══════════════════════════════════════════════════════
        //  타겟 경고
        // ══════════════════════════════════════════════════════
        const targetWarnings = [];
        const isHighSugar = sugars !== null && sugars > 15;
        const hasBadSweeteners = Object.keys(warningDict).some(
            w => ingredients.includes(w) && ["비만", "혈당", "당", "상승"].some(r => warningDict[w].risk.includes(r))
        );
        if (isHighSugar || hasBadSweeteners)
            targetWarnings.push("🩸 당뇨/혈당 스파이크 경고 (당류 과다 또는 혈당 교란 감미료 발견)");
        if (sodium !== null && sodium > 600)
            targetWarnings.push("🫀 심혈관/고혈압 주의 (1일 권장 나트륨 30% 이상 초과 위험)");
        const hasBadChemicals = Object.keys(warningDict).some(
            w => ingredients.includes(w) && ["발암", "ADHD", "벤젠", "색소"].some(r => warningDict[w].risk.includes(r))
        );
        if (hasBadChemicals || ingredients.includes("카페인") || ingredients.includes("caffeine"))
            targetWarnings.push("👶 영유아/임산부 섭취 강력 제한 요망 (발암/타르색소/보존료/카페인 발견)");

        // ══════════════════════════════════════════════════════
        //  그린워싱 경고
        // ══════════════════════════════════════════════════════
        let greenwashingAlert = null;
        const fakeKeywords = ["제로", "zero", "라이트", "light", "무가당", "슈가프리", "슈거프리", "천연", "내추럴", "내츄럴", "natural"];
        if (fakeKeywords.some(kw => fullName.toLowerCase().includes(kw)) && uniqueBadCount > 0) {
            greenwashingAlert = "🚨 [그린워싱 주의] 마케팅은 '제로/천연'이나, 실제 유해 감미료·화학제가 발견되었습니다.";
        }

        // ══════════════════════════════════════════════════════
        //  인증 (식약처 직접 조회 → 신뢰도 보장)
        // ══════════════════════════════════════════════════════
        const certifications = [];
        // 식약처 PRDLST_REPORT_NO 필드: 보고번호 존재 시 식약처 등록 제품
        if (krData?.PRDLST_REPORT_NO) certifications.push("🛡️ 식약처 등록 제품 (보고번호 확인됨)");
        const allTextForCert = (fullName + ingredients + (p?.labels_tags || []).join(" ")).toLowerCase();
        if (allTextForCert.includes("haccp") || allTextForCert.includes("해썹")) certifications.push("식약처 HACCP 시스템 인증");
        if (allTextForCert.includes("유기농") || allTextForCert.includes("organic")) certifications.push("유기농(Organic) 인증 🌱");
        if (allTextForCert.includes("무항생제") || allTextForCert.includes("무농약")) certifications.push("무농약/무항생제 검증 🌿");

        // ══════════════════════════════════════════════════════
        //  NOVA 분류 (OFF 기반)
        // ══════════════════════════════════════════════════════
        const novaDesc = {
            1: "자연 원재료 (건강식 🟢)",
            2: "기본 가공 식재료 (보통 🟡)",
            3: "가공식품 (화학첨가물 주의 🟠)",
            4: "초가공식품 (화학첨가물 다량 🔴)"
        };
        const nova = p?.nova_group ? `NOVA ${p.nova_group} - ${novaDesc[p.nova_group]}` : "정보 없음";

        // ══════════════════════════════════════════════════════
        //  알레르기 (OFF 기반 — 식약처 추후 연동 가능)
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
            productName: rawProductName,
            brand: brandInfo,
            fullName: fullName,
            origin: originText,                          // ✅ 식약처 공식 원산지
            ingredients: krData?.RAWMTRL_NM || "",      // ✅ 식약처 공식 원재료명 (UI 표시용)
            nutriGrade: p?.nutriscore_grade ? p.nutriscore_grade.toUpperCase() : null,
            calories: caloriesText,
            nova: nova,
            macros: macros,
            targetWarnings: targetWarnings,
            greenwashingAlert: greenwashingAlert,
            certifications: certifications,
            badIngredients: uniqueBadCount > 0
                ? detectedBadObjs
                : (additives.length > 0
                    ? [{ name: "가벼운 첨가물 일부 포함", risk: "적정 섭취 시 안전" }]
                    : [{ name: "친환경 원물", risk: "매우 안전 👍" }]),
            score: score,
            scoreBreakdown: scoreBreakdown,
            isScraped: false,                            // 식약처 직접 조회 → 스크래핑 없음
            allergens: translatedAllergens,
            image: p?.image_front_url || p?.image_url || p?.image_front_small_url || "",
            imageNutrition: p?.image_nutrition_url || null,
            imageIngredients: p?.image_ingredients_url || null,
            // 디버그용 (운영 시 제거 가능)
            _source: krData ? "식품안전나라(식약처)" : "Open Food Facts"
        });

    } catch (error) {
        console.error("scan.js 오류:", error);
        return res.status(500).json({ success: false, message: "서버 오류가 발생했습니다." });
    }
};
