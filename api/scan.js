// ============================================================
//  scan.js — 뚱땡이 아빠의 AI 식품 안전 스캐너 (v5 완전판)
//  핵심 수정:
//    ① parseKr — '0' 트랜스지방도 정상 처리
//    ② OFF fallback — serving 키명 오류 수정 (trans-fat_serving 등)
//    ③ 식약처 단독 소스 시 OFF null로 인한 영양성분 누락 완전 차단
//    ④ 이미지 URL — .400/.200/.small → .full 강제 치환 (짤림 해결)
//    ⑤ 알레르기 — 한글 원재료명 직접 탐지 (식약처 20종)
// ============================================================

const FOODSAFETY_KEY = process.env.FOODSAFETY_API_KEY || "0568dde2474141e595f9";

// ✅ 이미지 URL을 항상 full 해상도로 치환
function toFullImage(url) {
    if (!url) return "";
    return url
        .replace(/\.\d+\.jpg$/i, ".full.jpg")   // .400.jpg .200.jpg → .full.jpg
        .replace(/\.small\.jpg$/i, ".full.jpg"); // .small.jpg → .full.jpg
}

module.exports = async (req, res) => {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "No Barcode" });

    try {
        // ══════════════════════════════════════════════════════
        //  STEP 1. 식품안전나라 API (한국 제품 핵심 소스)
        // ══════════════════════════════════════════════════════
        let krData = null;
        try {
            const krUrl = `http://openapi.foodsafetykorea.go.kr/api/${FOODSAFETY_KEY}/C005/json/1/5/BAR_CD=${barcode}`;
            const krRes = await fetch(krUrl, { signal: AbortSignal.timeout(4000) });
            const krJson = await krRes.json();
            if (krJson?.C005?.row?.length > 0) krData = krJson.C005.row[0];
        } catch (e) { console.log("식품안전나라 실패:", e.message); }

        // ══════════════════════════════════════════════════════
        //  STEP 2. Open Food Facts (이미지·NOVA·알레르기 보조)
        // ══════════════════════════════════════════════════════
        let p = null;
        try {
            const offRes = await fetch(
                `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`,
                { signal: AbortSignal.timeout(4000) }
            );
            const offData = await offRes.json();
            if (offData.status === 1) p = offData.product;
        } catch (e) { console.log("OFF 실패:", e.message); }

        if (!krData && !p) {
            return res.status(200).json({ success: false, message: "DB에 아직 등록되지 않은 희귀 상품입니다 🥲" });
        }

        // ══════════════════════════════════════════════════════
        //  제품 기본 정보 (식약처 우선)
        // ══════════════════════════════════════════════════════
        const rawProductName = krData?.PRDLST_NM || p?.product_name_ko || p?.product_name || "미등록 상품";
        const brandInfo      = krData?.BSSH_NM   || p?.brands || "";
        const fullName       = (brandInfo && !rawProductName.includes(brandInfo))
            ? `${brandInfo} ${rawProductName}`.trim() : rawProductName;

        // ══════════════════════════════════════════════════════
        //  원산지 / 원재료명
        // ══════════════════════════════════════════════════════
        let originText = "제품 라벨 확인 필요";
        if (krData?.ORPLC_INFO?.trim())                          originText = krData.ORPLC_INFO.trim();
        else if (p?.origins?.trim())                             originText = p.origins.trim();
        else if (p?.countries_tags?.includes("en:south-korea"))  originText = "국산 (제조국 기준)";

        let ingredients = "";
        if (krData?.RAWMTRL_NM?.trim()) ingredients = krData.RAWMTRL_NM.trim().toLowerCase();
        else if (p)                     ingredients = (p.ingredients_text_ko || p.ingredients_text || "").toLowerCase();

        // ══════════════════════════════════════════════════════
        //  ✅ BUG FIX ① parseKr — '0'도 유효 (트랜스지방 0g 누락 수정)
        // ══════════════════════════════════════════════════════
        const parseKr = (val) => {
            if (val === undefined || val === null || val === "") return null;
            const n = parseFloat(String(val));
            return isNaN(n) ? null : n;
        };

        // ══════════════════════════════════════════════════════
        //  parseSize — g/ml 단위 파싱 ('86g', '1개(86g)', '86' 모두 처리)
        // ══════════════════════════════════════════════════════
        const parseSize = (str) => {
            if (!str) return null;
            const s = String(str);
            const m = s.match(/([\d.]+)\s*(g|ml)/i);
            if (m) return parseFloat(m[1]);
            const n = s.match(/^[\d.]+$/);
            return n ? parseFloat(n[0]) : null;
        };

        const servingSizeRaw = krData?.SERVING_SIZE || p?.serving_size || null;
        const servingG       = parseSize(servingSizeRaw);
        const netWtRaw       = krData?.NET_WT || p?.quantity || null;
        const netWtG         = parseSize(netWtRaw) || parseFloat(netWtRaw) || null;

        // 총 제공횟수: net_wt > serving_g 일 때만 역산 (같으면 1회짜리 제품)
        let totalServings = parseKr(krData?.SERVING_TOTAL) || null;
        if (!totalServings && servingG && netWtG && netWtG > servingG) {
            totalServings = Math.round(netWtG / servingG);
        }
        if (!totalServings) totalServings = 1;

        // ══════════════════════════════════════════════════════
        //  ✅ BUG FIX ②③ 영양성분 — 식약처 우선, OFF는 정확한 키명으로 보조
        //
        //  식약처 C005 필드 (1회 제공량 기준, mg/g):
        //    NUTR_CONT1=열량  NUTR_CONT2=탄수화물  NUTR_CONT3=당류
        //    NUTR_CONT4=지방  NUTR_CONT5=트랜스지방  NUTR_CONT6=포화지방
        //    NUTR_CONT7=콜레스테롤  NUTR_CONT8=단백질  NUTR_CONT9=나트륨(mg)
        //
        //  OFF nutriments 실제 키명:
        //    energy-kcal_100g / energy-kcal_serving
        //    carbohydrates_100g / carbohydrates_serving  (← 기존 코드 오타 없음)
        //    sugars_100g / sugars_serving
        //    fat_100g / fat_serving
        //    saturated-fat_100g / saturated-fat_serving  (← 하이픈 주의)
        //    trans-fat_100g / trans-fat_serving          (← 하이픈 주의)
        //    proteins_100g / proteins_serving
        //    sodium_100g / sodium_serving                (g 단위 → ×1000 = mg)
        // ══════════════════════════════════════════════════════
        const n = p?.nutriments || {};

        // OFF에서 1회 제공량 기준 값 추출 (serving 우선, 없으면 100g×비율)
        const offServing = (key100, keyServing) => {
            if (n[keyServing] != null) return n[keyServing];
            if (n[key100]    != null && servingG) return n[key100] * servingG / 100;
            return null;
        };

        // 식약처 값이 있으면 무조건 우선 사용, null일 때만 OFF 참조
        // ?? 연산자: 좌변이 null/undefined일 때만 우변 실행
        const kcalPS   = parseKr(krData?.NUTR_CONT1) ?? offServing("energy-kcal_100g",    "energy-kcal_serving");
        const carbsPS  = parseKr(krData?.NUTR_CONT2) ?? offServing("carbohydrates_100g",   "carbohydrates_serving");
        const sugarsPS = parseKr(krData?.NUTR_CONT3) ?? offServing("sugars_100g",          "sugars_serving");
        const fatPS    = parseKr(krData?.NUTR_CONT4) ?? offServing("fat_100g",             "fat_serving");
        const transFPS = parseKr(krData?.NUTR_CONT5) ?? offServing("trans-fat_100g",       "trans-fat_serving");
        const satFPS   = parseKr(krData?.NUTR_CONT6) ?? offServing("saturated-fat_100g",   "saturated-fat_serving");
        const protPS   = parseKr(krData?.NUTR_CONT8) ?? offServing("proteins_100g",        "proteins_serving");

        // 나트륨: 식약처 = mg, OFF = g → ×1000 변환
        const sodiumPS = parseKr(krData?.NUTR_CONT9) ??
            (n["sodium_serving"] != null ? n["sodium_serving"] * 1000 :
             n["sodium_100g"]    != null && servingG ? n["sodium_100g"] * 1000 * servingG / 100 : null);

        // 제품 전체 기준 환산 (× 총 제공횟수)
        const toTotal = (val) => val !== null ? Math.round(val * totalServings * 10) / 10 : null;
        const kcalT   = toTotal(kcalPS);
        const carbsT  = toTotal(carbsPS);
        const sugarsT = toTotal(sugarsPS);
        const fatT    = toTotal(fatPS);
        const transFT = toTotal(transFPS);
        const satFT   = toTotal(satFPS);
        const protT   = toTotal(protPS);
        const sodiumT = toTotal(sodiumPS);

        // ══════════════════════════════════════════════════════
        //  칼로리 표기
        // ══════════════════════════════════════════════════════
        let caloriesText = "열량 정보 없음 (비공개)";
        if (kcalT !== null) {
            const baseStr = netWtRaw ? `${netWtRaw} 전체` : `제품 1개 전체`;
            const servStr = (kcalPS !== null && totalServings > 1)
                ? ` (1회 ${servingSizeRaw}: ${Math.round(kcalPS)}kcal × ${totalServings}회)` : "";
            caloriesText = `${baseStr}: ${kcalT}kcal${servStr}`;
        }

        // ══════════════════════════════════════════════════════
        //  유해 성분 분석
        // ══════════════════════════════════════════════════════
        const warningDict = {
            "설탕":          { name: "설탕",                    risk: "과다 섭취 시 만성 염증·비만·간 손상 위험 ⚠️" },
            "sugar":         { name: "설탕",                    risk: "혈당 급상승 및 대사 증후군 유발 ⚠️" },
            "과당":          { name: "액상과당 (콘시럽)",        risk: "설탕보다 흡수 빨라 체지방(지방간) 축적 주범 🔴" },
            "물엿":          { name: "물엿/단당류",              risk: "혈당 급상승 ⚠️" },
            "수크랄로스":    { name: "수크랄로스",              risk: "인공 감미료: 장내 유익균 파괴·인슐린 저항성 악화 🔴" },
            "sucralose":     { name: "수크랄로스",              risk: "인공 감미료 🔴" },
            "아스파탐":      { name: "아스파탐",                risk: "인공 감미료: WHO 발암가능물질 지정·신경계 교란 🔴" },
            "aspartame":     { name: "아스파탐",                risk: "인공 감미료 🔴" },
            "사카린":        { name: "사카린나트륨",            risk: "인공 감미료: 장기 섭취 시 소화기 부작용 우려 ⚠️" },
            "아세설팜칼륨":  { name: "아세설팜칼륨",            risk: "인공 감미료: 갑상선 기능 영향 우려 ⚠️" },
            "acesulfame k":  { name: "아세설팜칼륨",            risk: "인공 감미료 ⚠️" },
            "팜유":          { name: "팜유",                    risk: "포화지방 과다 → LDL 콜레스테롤 상승 ⚠️" },
            "palm oil":      { name: "팜유",                    risk: "포화지방 과다 ⚠️" },
            "마가린":        { name: "마가린",                  risk: "트랜스지방 함유 → 혈관 벽 손상 🔴" },
            "쇼트닝":        { name: "쇼트닝",                  risk: "트랜스지방 함유 → 혈관 벽 손상 🔴" },
            "소르빈산":      { name: "소르빈산염",              risk: "보존료: 피부 점막 자극·알레르기 유발 우려 ⚠️" },
            "아질산나트륨":  { name: "아질산나트륨",            risk: "발색제: 1급 발암물질(니트로사민) 생성 위험 🔴" },
            "안식향산나트륨":{ name: "안식향산나트륨",          risk: "보존료: 비타민C 결합 시 벤젠(1급 발암) 생성 🔴" },
            "글루탐산나트륨":{ name: "L-글루탐산나트륨 (MSG)",  risk: "향미증진제: 민감 체질 두통·발진 유발 ⚠️" },
            "msg":           { name: "MSG",                     risk: "민감 체질 부작용 우려 ⚠️" },
            "합성향료":      { name: "합성향료",                risk: "미확인 화학물질 배합: 알레르기·두통 원인 ⚠️" },
            "타르색소":      { name: "타르색소",                risk: "인공 착색료: 아동 ADHD·정서 불안 촉발 의심 🔴" },
            "적색40호":      { name: "적색40호",                risk: "인공 색소: 과잉행동장애 의심 🔴" },
            "황색4호":       { name: "황색4호",                 risk: "인공 색소: 천식 알레르기 의심 🔴" },
            "황색5호":       { name: "황색5호",                 risk: "인공 색소: 알레르기 반응 의심 ⚠️" },
            "카라멜색소":    { name: "카라멜색소",              risk: "4-MEI 발암물질 포함 가능성 ⚠️" },
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
        //  ✅ BUG FIX ⑤ 알레르기 — 한글 원재료명 직접 탐지 (식약처 22종)
        // ══════════════════════════════════════════════════════
        const krAllergenMap = [
            { keys: ["우유","탈지분유","전지분유","유청","버터","치즈","크림"], label: "우유 (유제품)" },
            { keys: ["대두","두유","콩"],                                        label: "대두(콩)" },
            { keys: ["밀","소맥분","글루텐","빵가루"],                           label: "밀 (글루텐)" },
            { keys: ["달걀","계란","난백","난황"],                               label: "달걀" },
            { keys: ["땅콩","피넛"],                                              label: "땅콩 (🔴 쇼크 위험)" },
            { keys: ["새우","건새우"],                                            label: "새우 (갑각류 🔴)" },
            { keys: ["게","꽃게"],                                                label: "게 (갑각류 🔴)" },
            { keys: ["고등어"],                                                   label: "고등어 (생선)" },
            { keys: ["복숭아"],                                                   label: "복숭아" },
            { keys: ["토마토"],                                                   label: "토마토" },
            { keys: ["아황산","이산화황"],                                        label: "아황산염 (🔴 천식 주의)" },
            { keys: ["호두"],                                                     label: "호두 (견과류)" },
            { keys: ["잣"],                                                       label: "잣 (견과류)" },
            { keys: ["아몬드"],                                                   label: "아몬드 (견과류)" },
            { keys: ["참깨","참기름"],                                            label: "참깨" },
            { keys: ["돼지고기","돈육","돈지"],                                   label: "돼지고기" },
            { keys: ["소고기","우육","쇠고기"],                                   label: "소고기" },
            { keys: ["닭고기","계육"],                                            label: "닭고기" },
            { keys: ["오징어"],                                                   label: "오징어 (연체동물)" },
            { keys: ["조개","굴","홍합","전복"],                                  label: "조개류 (연체동물)" },
        ];

        const allergenDict = {
            "milk":"우유","soybeans":"대두","wheat":"밀","eggs":"달걀",
            "peanuts":"땅콩 (🔴 쇼크 위험)","fish":"생선","crustaceans":"갑각류 (🔴)",
            "tree nuts":"견과류","mustard":"머스타드","sesame":"참깨",
            "sulphites":"아황산염 (🔴 천식 주의)","molluscs":"연체동물",
            "gluten":"글루텐","soy":"콩","pork":"돼지고기","beef":"소고기"
        };

        // ① 한글 원재료명 직접 탐지
        const krAllergens = [];
        const ingForAllergen = (krData?.RAWMTRL_NM || "").toLowerCase();
        if (ingForAllergen) {
            krAllergenMap.forEach(({ keys, label }) => {
                if (keys.some(k => ingForAllergen.includes(k)) && !krAllergens.includes(label))
                    krAllergens.push(label);
            });
        }

        // ② OFF 영문 알레르기 한글 변환
        let offAllergens = [];
        if (p?.allergens_tags?.length > 0) {
            offAllergens = p.allergens_tags.map(tag =>
                allergenDict[tag.replace(/en:|fr:|ko:/g, "").toLowerCase()] ||
                tag.replace(/en:|fr:|ko:/g, "").toLowerCase()
            );
        } else if (p?.allergens_from_ingredients) {
            let raw = p.allergens_from_ingredients.replace(/en:/g, "").toLowerCase();
            Object.keys(allergenDict).forEach(en => {
                raw = raw.replace(new RegExp(`\\b${en}\\b`, "gi"), allergenDict[en]);
            });
            if (raw.trim()) offAllergens = raw.split(",").map(s => s.trim()).filter(Boolean);
        }

        // ③ 병합 (중복 제거)
        const translatedAllergens = [...new Set([...krAllergens, ...offAllergens])];
        if (translatedAllergens.length === 0) translatedAllergens.push("없음");

        // ══════════════════════════════════════════════════════
        //  점수 산정
        // ══════════════════════════════════════════════════════
        let baseScore = 100;
        const scoreBreakdown = [];
        if (additives.length > 0) {
            const p1 = Math.min(additives.length * 5, 40);
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
        //  영양소 위험도 (K-FDA 1일 권장량 기준, 제품 전체)
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
            fat:    kfdaPercent(fatT,    54,   "지방"),
            sugars: kfdaPercent(sugarsT, 100,  "당류"),
            sodium: kfdaPercent(sodiumT, 2000, "나트륨"),
        };

        // ══════════════════════════════════════════════════════
        //  타겟 경고
        // ══════════════════════════════════════════════════════
        const targetWarnings = [];
        if ((sugarsT !== null && sugarsT > 25) ||
            Object.keys(warningDict).some(w => ingredients.includes(w) && ["비만","혈당","당","상승"].some(r => warningDict[w].risk.includes(r))))
            targetWarnings.push("🩸 당뇨/혈당 스파이크 경고 (제품 1개 당류 과다 또는 혈당 교란 감미료 발견)");
        if (sodiumT !== null && sodiumT > 1000)
            targetWarnings.push("🫀 심혈관/고혈압 주의 (제품 1개 나트륨이 1일 권장량 50% 초과)");
        if (Object.keys(warningDict).some(w => ingredients.includes(w) &&
            ["발암","ADHD","벤젠","색소"].some(r => warningDict[w].risk.includes(r)))
            || ingredients.includes("카페인") || ingredients.includes("caffeine"))
            targetWarnings.push("👶 영유아/임산부 섭취 강력 제한 요망 (발암/타르색소/보존료/카페인 발견)");

        // ══════════════════════════════════════════════════════
        //  그린워싱 / 인증 / NOVA
        // ══════════════════════════════════════════════════════
        let greenwashingAlert = null;
        const fakeKeywords = ["제로","zero","라이트","light","무가당","슈가프리","슈거프리","천연","내추럴","내츄럴","natural"];
        if (fakeKeywords.some(kw => fullName.toLowerCase().includes(kw)) && uniqueBadCount > 0)
            greenwashingAlert = "🚨 [그린워싱 주의] 마케팅은 '제로/천연'이나, 실제 유해 감미료·화학제가 발견되었습니다.";

        const certifications = [];
        if (krData?.PRDLST_REPORT_NO) certifications.push("🛡️ 식약처 등록 제품 (보고번호 확인됨)");
        const allTextForCert = (fullName + ingredients + (p?.labels_tags || []).join(" ")).toLowerCase();
        if (allTextForCert.includes("haccp") || allTextForCert.includes("해썹")) certifications.push("식약처 HACCP 시스템 인증");
        if (allTextForCert.includes("유기농") || allTextForCert.includes("organic")) certifications.push("유기농(Organic) 인증 🌱");
        if (allTextForCert.includes("무항생제") || allTextForCert.includes("무농약")) certifications.push("무농약/무항생제 검증 🌿");

        const novaDesc = { 1:"자연 원재료 (건강식 🟢)", 2:"기본 가공 식재료 (보통 🟡)", 3:"가공식품 (화학첨가물 주의 🟠)", 4:"초가공식품 (화학첨가물 다량 🔴)" };
        function estimateNova(cat, ing) {
            cat = (cat||"").toLowerCase(); ing = (ing||"").toLowerCase();
            if (["신선","생과일","냉동과일","냉동채소"].some(k=>cat.includes(k))) return 1;
            const u4cat = ["과자","라면","탄산음료","아이스크림","햄","소시지","어묵","케첩","마요네즈","스낵","캔디","초콜릿","비스킷","컵라면"];
            const u4ing = ["합성향료","타르색소","아질산","수크랄로스","아스파탐","아세설팜","안식향산","소르빈산","쇼트닝"];
            if (u4cat.some(k=>cat.includes(k)) || u4ing.some(k=>ing.includes(k))) return 4;
            const p3 = ["음료","빵","면류","통조림","소스","드레싱","잼","요구르트","치즈","두부","김치","젓갈"];
            if (p3.some(k=>cat.includes(k))) return 3;
            return 3;
        }
        const novaGroup  = p?.nova_group || estimateNova(krData?.PRDLST_DCNM, ingredients);
        const nova = `NOVA ${novaGroup} - ${novaDesc[novaGroup]}${p?.nova_group ? "" : " (추정)"}`;

        // ══════════════════════════════════════════════════════
        //  ✅ BUG FIX ④ 이미지 — 모든 URL을 .full.jpg로 강제 치환
        // ══════════════════════════════════════════════════════
        const productImage = toFullImage(
            p?.image_front_url ||
            p?.image_url       ||
            p?.image_front_small_url || ""
        );

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

            nutriDetail: {
                basis:        netWtRaw ? `${netWtRaw} 전체 기준` : `제품 1개(${totalServings}회분) 전체 기준`,
                servingInfo:  (servingSizeRaw && totalServings > 1) ? `1회 제공량: ${servingSizeRaw} × ${totalServings}회` : null,
                kcal:         kcalT,
                carbs:        carbsT   !== null ? `${carbsT}g`              : null,
                sugars:       sugarsT  !== null ? `${sugarsT}g`             : null,
                fat:          fatT     !== null ? `${fatT}g`                : null,
                saturatedFat: satFT    !== null ? `${satFT}g`               : null,
                transFat:     transFT  !== null ? `${transFT}g`             : null,
                protein:      protT    !== null ? `${protT}g`               : null,
                sodium:       sodiumT  !== null ? `${Math.round(sodiumT)}mg`: null,
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
            image:          productImage,
            imageNutrition:  toFullImage(p?.image_nutrition_url  || ""),
            imageIngredients:toFullImage(p?.image_ingredients_url|| ""),
            _source: krData ? "식품안전나라(식약처)" : "Open Food Facts"
        });

    } catch (error) {
        console.error("scan.js 오류:", error);
        return res.status(500).json({ success: false, message: "서버 오류가 발생했습니다." });
    }
};
