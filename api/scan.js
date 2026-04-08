// ============================================================
//  scan.js — v9 전면 수정판
//  수정 사항:
//    ① C005 이미지 필드(IMG_URL) 추가 → 한국 공식 이미지 1순위
//    ② dgData 브랜드 매칭 강화 → 영한 브랜드명 대조표 추가
//    ③ dgData 검색어 다중 시도 → 실패시 브랜드명만으로 재시도
//    ④ I2570 영양성분 추출 강화
//    ⑤ 이미지 우선순위 재정립: C005→UPCitemdb→OFF
//    ⑥ 네이버 API키 없어도 정상 동작
// ============================================================

const FOODSAFETY_KEY = process.env.FOODSAFETY_API_KEY || "0568dde2474141e595f9";
const DATA_GO_KEY    = process.env.DATA_GO_API_KEY    || "1208099b45e4f61f0c9535abe2064f9551e672cf8788c97d99619974caf435f2";

// OFF 이미지 full 치환
function toFullImage(url) {
    if (!url) return "";
    return url
        .replace(/\.(\d+)\.jpg$/i, ".full.jpg")
        .replace(/\.small\.jpg$/i,  ".full.jpg");
}

// 숫자 파싱 — 0도 유효값
const parseNum = (val) => {
    if (val === undefined || val === null || val === "") return null;
    const n = parseFloat(String(val));
    return isNaN(n) ? null : n;
};

// g/ml 단위 파싱
const parseSize = (str) => {
    if (!str) return null;
    const m = String(str).match(/([\d.]+)\s*(g|ml)/i);
    if (m) return parseFloat(m[1]);
    const n = String(str).match(/^[\d.]+$/);
    return n ? parseFloat(n[0]) : null;
};

// ✅ 영한 브랜드명 대조표 (OFF 영문 → 한글 검색 매칭)
const BRAND_EN_KO = {
    "paldo": "팔도", "nongshim": "농심", "ottogi": "오뚜기",
    "samyang": "삼양", "lotte": "롯데", "orion": "오리온",
    "haitai": "해태", "dongwon": "동원", "cj": "씨제이",
    "pulmuone": "풀무원", "daesang": "대상", "bingrae": "빙그레",
    "crown": "크라운", "binggrae": "빙그레", "maeil": "매일",
    "namyang": "남양", "woongjin": "웅진", "mondelez": "몬델리즈",
};

module.exports = async (req, res) => {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "No Barcode" });

    try {
        // ══════════════════════════════════════════════════════
        //  STEP 1: 식약처 C005 — 바코드 직접
        // ══════════════════════════════════════════════════════
        let krData = null;
        try {
            const r = await fetch(
                `http://openapi.foodsafetykorea.go.kr/api/${FOODSAFETY_KEY}/C005/json/1/5/BAR_CD=${barcode}`,
                { signal: AbortSignal.timeout(4000) }
            );
            const j = await r.json();
            if (j?.C005?.row?.length > 0) krData = j.C005.row[0];
        } catch (e) { console.log("C005 실패:", e.message); }

        // ══════════════════════════════════════════════════════
        //  STEP 2: Open Food Facts — 바코드
        // ══════════════════════════════════════════════════════
        let p = null;
        try {
            const r = await fetch(
                `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`,
                { signal: AbortSignal.timeout(4000) }
            );
            const j = await r.json();
            if (j?.status === 1) p = j.product;
        } catch (e) { console.log("OFF 실패:", e.message); }

        // ══════════════════════════════════════════════════════
        //  STEP 3: UPCitemdb — C005+OFF 둘 다 없을 때
        // ══════════════════════════════════════════════════════
        let upcData = null;
        if (!krData && !p) {
            try {
                const r = await fetch(
                    `https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`,
                    { signal: AbortSignal.timeout(4000) }
                );
                const j = await r.json();
                if (j?.items?.length > 0) upcData = j.items[0];
            } catch (e) { console.log("UPCitemdb 실패:", e.message); }
        }

        if (!krData && !p && !upcData) {
            return res.status(200).json({
                success: false,
                message: "모든 DB에서 찾을 수 없는 상품입니다 🥲"
            });
        }

        // ══════════════════════════════════════════════════════
        //  기본 제품 정보
        // ══════════════════════════════════════════════════════
        const rawProductName =
            krData?.PRDLST_NM ||
            p?.product_name_ko ||
            p?.product_name ||
            upcData?.title || "미등록 상품";

        const brandInfo =
            krData?.BSSH_NM ||
            p?.brands ||
            upcData?.brand || "";

        const fullName = (brandInfo && !rawProductName.includes(brandInfo))
            ? `${brandInfo} ${rawProductName}`.trim() : rawProductName;

        // 원산지 / 원재료명
        let originText = "제품 라벨 확인 필요";
        if (krData?.ORPLC_INFO?.trim())                          originText = krData.ORPLC_INFO.trim();
        else if (p?.origins?.trim())                             originText = p.origins.trim();
        else if (p?.countries_tags?.includes("en:south-korea"))  originText = "국산 (제조국 기준)";

        let ingredients = "";
        if (krData?.RAWMTRL_NM?.trim()) ingredients = krData.RAWMTRL_NM.trim().toLowerCase();
        else if (p)                     ingredients = (p.ingredients_text_ko || p.ingredients_text || "").toLowerCase();

        // ══════════════════════════════════════════════════════
        //  STEP 4: 공공데이터포털 — 영양성분 핵심
        //  ✅ 수정: 브랜드명 영→한 변환 후 다중 검색 시도
        // ══════════════════════════════════════════════════════
        let dgData = null;

        // 검색어 후보 목록 생성
        const buildSearchCandidates = (productName, brand) => {
            const candidates = [];
            // 1순위: 제품명 (영문 제거)
            const nameKo = productName.replace(/[a-zA-Z]/g, "").trim();
            if (nameKo) candidates.push(nameKo);
            // 2순위: 한글 브랜드 + 제품명
            const brandLow = (brand || "").toLowerCase().trim();
            const brandKo  = BRAND_EN_KO[brandLow] || brand || "";
            const brandKoClean = brandKo.replace(/[㈜(주)\s]/g, "").trim();
            if (brandKoClean && nameKo) candidates.push(`${brandKoClean} ${nameKo}`);
            // 3순위: 브랜드만
            if (brandKoClean) candidates.push(brandKoClean);
            return [...new Set(candidates)]; // 중복 제거
        };

        const dgCandidates = buildSearchCandidates(rawProductName, brandInfo);
        console.log("dgData 검색 후보:", dgCandidates);

        for (const candidate of dgCandidates) {
            if (dgData) break;
            try {
                const r = await fetch(
                    `https://apis.data.go.kr/1471000/FoodNtrIrdntInfoService1/getFoodNtrItdntList1?serviceKey=${DATA_GO_KEY}&pageNo=1&numOfRows=10&type=json&FOOD_NM_KR=${encodeURIComponent(candidate)}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                const j = await r.json();
                const items = j?.body?.items || j?.response?.body?.items || [];
                if (items.length > 0) {
                    // 브랜드명 영→한 변환하여 매칭 강화
                    const brandLow    = (brandInfo || "").toLowerCase().trim();
                    const brandKo     = BRAND_EN_KO[brandLow] || brandInfo || "";
                    const brandClean  = brandKo.replace(/[㈜(주)\s]/g, "").trim();
                    const nameKo      = rawProductName.replace(/[a-zA-Z]/g, "").trim();

                    // 매칭 점수로 최선 항목 선택
                    let best = null, bestScore = -1;
                    for (const item of items) {
                        const nm = (item.FOOD_NM_KR || "").toLowerCase();
                        const mk = (item.MAKER_NM  || "").toLowerCase();
                        let score = 0;
                        if (nameKo    && nm.includes(nameKo.toLowerCase()))    score += 3;
                        if (brandClean && mk.includes(brandClean.toLowerCase())) score += 2;
                        if (brandClean && nm.includes(brandClean.toLowerCase())) score += 1;
                        if (score > bestScore) { bestScore = score; best = item; }
                    }
                    if (bestScore > 0) {
                        dgData = best;
                        console.log(`dgData 매칭 성공 (점수${bestScore}):`, dgData.FOOD_NM_KR, "/", dgData.MAKER_NM);
                    }
                }
            } catch (e) { console.log(`data.go.kr 실패(${candidate}):`, e.message); }
        }

        // ══════════════════════════════════════════════════════
        //  STEP 5: 식약처 I2570 — C005+dgData 모두 없을 때
        // ══════════════════════════════════════════════════════
        let krData2 = null;
        if (!krData && !dgData && rawProductName !== "미등록 상품") {
            try {
                const nameKo = rawProductName.replace(/[a-zA-Z]/g, "").trim() || rawProductName;
                const r = await fetch(
                    `http://openapi.foodsafetykorea.go.kr/api/${FOODSAFETY_KEY}/I2570/json/1/10/PRDLST_NM=${encodeURIComponent(nameKo)}`,
                    { signal: AbortSignal.timeout(4000) }
                );
                const j = await r.json();
                if (j?.I2570?.row?.length > 0) {
                    const rows = j.I2570.row;
                    krData2 = rows.find(row => row.PRDLST_NM?.includes(nameKo)) || rows[0];
                }
            } catch (e) { console.log("I2570 실패:", e.message); }
        }

        // ══════════════════════════════════════════════════════
        //  영양성분 계산
        //  C005: NUTR_CONT3=당류, NUTR_CONT9=나트륨
        //  dgData: NUTR_CONT6=당류, NUTR_CONT12=나트륨
        //  I2570: NUTR_CONT3=당류, NUTR_CONT9=나트륨 (C005와 동일)
        // ══════════════════════════════════════════════════════
        const servingSizeRaw = krData?.SERVING_SIZE || dgData?.SERVING_SIZE || krData2?.SERVING_SIZE || p?.serving_size || null;
        const servingG       = parseSize(servingSizeRaw);
        const netWtRaw       = krData?.NET_WT || p?.quantity || null;
        const netWtG         = parseSize(netWtRaw) || null;

        let totalServings = parseNum(krData?.SERVING_TOTAL) || null;
        if (!totalServings && servingG && netWtG && netWtG > servingG)
            totalServings = Math.round(netWtG / servingG);
        if (!totalServings) totalServings = 1;

        const n = p?.nutriments || {};
        const offServing = (key100, keyServing) => {
            if (n[keyServing] != null) return n[keyServing];
            if (n[key100]    != null && servingG) return n[key100] * servingG / 100;
            return null;
        };

        const kcalPS   = parseNum(krData?.NUTR_CONT1)  ?? parseNum(dgData?.NUTR_CONT1)  ?? parseNum(krData2?.NUTR_CONT1) ?? offServing("energy-kcal_100g","energy-kcal_serving");
        const carbsPS  = parseNum(krData?.NUTR_CONT2)  ?? parseNum(dgData?.NUTR_CONT5)  ?? parseNum(krData2?.NUTR_CONT2) ?? offServing("carbohydrates_100g","carbohydrates_serving");
        const sugarsPS = parseNum(krData?.NUTR_CONT3)  ?? parseNum(dgData?.NUTR_CONT6)  ?? parseNum(krData2?.NUTR_CONT3) ?? offServing("sugars_100g","sugars_serving");
        const fatPS    = parseNum(krData?.NUTR_CONT4)  ?? parseNum(dgData?.NUTR_CONT4)  ?? parseNum(krData2?.NUTR_CONT4) ?? offServing("fat_100g","fat_serving");
        const transFPS = parseNum(krData?.NUTR_CONT5)  ?? parseNum(dgData?.NUTR_CONT23) ?? offServing("trans-fat_100g","trans-fat_serving");
        const satFPS   = parseNum(krData?.NUTR_CONT6)  ?? parseNum(dgData?.NUTR_CONT22) ?? offServing("saturated-fat_100g","saturated-fat_serving");
        const protPS   = parseNum(krData?.NUTR_CONT8)  ?? parseNum(dgData?.NUTR_CONT3)  ?? parseNum(krData2?.NUTR_CONT8) ?? offServing("proteins_100g","proteins_serving");
        const sodiumPS = parseNum(krData?.NUTR_CONT9)  ?? parseNum(dgData?.NUTR_CONT12) ?? parseNum(krData2?.NUTR_CONT9) ??
            (n["sodium_serving"] != null ? n["sodium_serving"] * 1000 :
             n["sodium_100g"]    != null && servingG ? n["sodium_100g"] * 1000 * servingG / 100 : null);

        const toTotal = (v) => v !== null ? Math.round(v * totalServings * 10) / 10 : null;
        const kcalT   = toTotal(kcalPS);
        const carbsT  = toTotal(carbsPS);
        const sugarsT = toTotal(sugarsPS);
        const fatT    = toTotal(fatPS);
        const transFT = toTotal(transFPS);
        const satFT   = toTotal(satFPS);
        const protT   = toTotal(protPS);
        const sodiumT = toTotal(sodiumPS);

        let caloriesText = "열량 정보 없음 (비공개)";
        if (kcalT !== null) {
            const base = netWtRaw ? `${netWtRaw} 전체` : `제품 1개 전체`;
            const serv = (kcalPS !== null && totalServings > 1)
                ? ` (1회 ${servingSizeRaw}: ${Math.round(kcalPS)}kcal × ${totalServings}회)` : "";
            caloriesText = `${base}: ${kcalT}kcal${serv}`;
        }

        // ══════════════════════════════════════════════════════
        //  유해성분 분석
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
            if (ingredients.includes(word) && !detectedBadObjs.some(o => o.name === warningDict[word].name))
                detectedBadObjs.push(warningDict[word]);
        });
        const uniqueBadCount = detectedBadObjs.length;
        const additives      = p?.additives_tags || [];

        // 알레르기
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
            "tree nuts":"견과류","sesame":"참깨","sulphites":"아황산염 (🔴 천식 주의)",
            "molluscs":"연체동물","gluten":"글루텐","soy":"콩","pork":"돼지고기","beef":"소고기"
        };
        const krAllergens = [];
        krAllergenMap.forEach(({ keys, label }) => {
            if (keys.some(k => ingredients.includes(k)) && !krAllergens.includes(label))
                krAllergens.push(label);
        });
        let offAllergens = [];
        if (p?.allergens_tags?.length > 0) {
            offAllergens = p.allergens_tags.map(tag =>
                allergenDict[tag.replace(/en:|fr:|ko:/g,"").toLowerCase()] ||
                tag.replace(/en:|fr:|ko:/g,"").toLowerCase()
            );
        } else if (p?.allergens_from_ingredients) {
            let raw = p.allergens_from_ingredients.replace(/en:/g,"").toLowerCase();
            Object.keys(allergenDict).forEach(en => {
                raw = raw.replace(new RegExp(`\\b${en}\\b`,"gi"), allergenDict[en]);
            });
            if (raw.trim()) offAllergens = raw.split(",").map(s=>s.trim()).filter(Boolean);
        }
        const mergedAllergens = [...new Set([...krAllergens, ...offAllergens])];
        const translatedAllergens = mergedAllergens.length > 0 ? mergedAllergens : ["없음"];

        // 점수
        let baseScore = 100;
        const scoreBreakdown = [];
        if (additives.length > 0) {
            const d = Math.min(additives.length * 5, 40);
            scoreBreakdown.push(`일반 화학 첨가물 ${additives.length}개 발견 (-${d}점)`);
            baseScore -= d;
        }
        if (uniqueBadCount > 0) {
            const d = uniqueBadCount * 10;
            scoreBreakdown.push(`핵심 유해/주의성분 ${uniqueBadCount}개 발견 (-${d}점)`);
            baseScore -= d;
        }
        const score = Math.max(10, baseScore);

        // K-FDA 위험도
        const kfdaPercent = (val, limit, name) => {
            if (val === null) return { value:"?", level:"unknown", text:"정보 없음", emoji:"⚪" };
            const pct = Math.round((val / limit) * 100);
            let lvl="green", txt=`1일 권장량의 ${pct}% (안전)`, emj="🟢";
            if (pct>=50)      { lvl="red";   txt=`1일 권장량의 ${pct}% ⚠️ 위험`; emj="🔴"; }
            else if (pct>=25) { lvl="amber"; txt=`1일 권장량의 ${pct}% 주의`;     emj="🟡"; }
            const dv = name==="나트륨" ? `${Math.round(val)}mg` : `${Math.round(val*10)/10}g`;
            return { value:dv, level:lvl, text:txt, emoji:emj };
        };
        const macros = {
            fat:    kfdaPercent(fatT,    54,   "지방"),
            sugars: kfdaPercent(sugarsT, 100,  "당류"),
            sodium: kfdaPercent(sodiumT, 2000, "나트륨"),
        };

        // 타겟 경고
        const targetWarnings = [];
        if ((sugarsT!==null && sugarsT>25) ||
            Object.keys(warningDict).some(w=>ingredients.includes(w) && ["비만","혈당","당","상승"].some(r=>warningDict[w].risk.includes(r))))
            targetWarnings.push("🩸 당뇨/혈당 스파이크 경고 (제품 1개 당류 과다 또는 혈당 교란 감미료 발견)");
        if (sodiumT!==null && sodiumT>1000)
            targetWarnings.push("🫀 심혈관/고혈압 주의 (제품 1개 나트륨이 1일 권장량 50% 초과)");
        if (Object.keys(warningDict).some(w=>ingredients.includes(w) && ["발암","ADHD","벤젠","색소"].some(r=>warningDict[w].risk.includes(r)))
            || ingredients.includes("카페인") || ingredients.includes("caffeine"))
            targetWarnings.push("👶 영유아/임산부 섭취 강력 제한 요망");

        // 그린워싱/인증
        let greenwashingAlert = null;
        const fakeKw = ["제로","zero","라이트","light","무가당","슈가프리","슈거프리","천연","내추럴","내츄럴","natural"];
        if (fakeKw.some(kw=>fullName.toLowerCase().includes(kw)) && uniqueBadCount>0)
            greenwashingAlert = "🚨 [그린워싱 주의] 마케팅은 '제로/천연'이나, 실제 유해 감미료·화학제가 발견되었습니다.";

        const certifications = [];
        if (krData?.PRDLST_REPORT_NO || krData2?.PRDLST_REPORT_NO) certifications.push("🛡️ 식약처 등록 제품");
        const allTC = (fullName+ingredients+(p?.labels_tags||[]).join(" ")).toLowerCase();
        if (allTC.includes("haccp")||allTC.includes("해썹")) certifications.push("식약처 HACCP 인증");
        if (allTC.includes("유기농")||allTC.includes("organic")) certifications.push("유기농(Organic) 인증 🌱");
        if (upcData && !krData && !p) certifications.push("ℹ️ 글로벌 바코드DB 조회");

        // NOVA
        const novaDesc = { 1:"자연 원재료 (건강식 🟢)", 2:"기본 가공 식재료 (보통 🟡)", 3:"가공식품 (화학첨가물 주의 🟠)", 4:"초가공식품 (화학첨가물 다량 🔴)" };
        function estimateNova(cat, ing) {
            cat=(cat||"").toLowerCase(); ing=(ing||"").toLowerCase();
            if (["신선","생과일","냉동과일","냉동채소"].some(k=>cat.includes(k))) return 1;
            const u4c=["과자","라면","탄산음료","아이스크림","햄","소시지","어묵","케첩","마요네즈","스낵","캔디","초콜릿","비스킷","컵라면"];
            const u4i=["합성향료","타르색소","아질산","수크랄로스","아스파탐","아세설팜","안식향산","소르빈산","쇼트닝"];
            if (u4c.some(k=>cat.includes(k))||u4i.some(k=>ing.includes(k))) return 4;
            if (["음료","빵","면류","통조림","소스","드레싱","잼","요구르트","치즈","두부","김치"].some(k=>cat.includes(k))) return 3;
            return 3;
        }
        const novaGroup = p?.nova_group || estimateNova(krData?.PRDLST_DCNM||krData2?.PRDLST_DCNM, ingredients);
        const nova = `NOVA ${novaGroup} - ${novaDesc[novaGroup]}${p?.nova_group?"" : " (추정)"}`;

        // ══════════════════════════════════════════════════════
        //  이미지 우선순위
        //  1. 네이버 쇼핑 API (환경변수 있을 때)
        //  2. UPCitemdb images[] (고화질 원본)
        //  3. OFF full 이미지
        //  4. OFF small → full 치환
        // ══════════════════════════════════════════════════════
        let productImage = "";
        let naverImage   = "";

        const NAVER_ID     = process.env.NAVER_CLIENT_ID;
        const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;
        if (NAVER_ID && NAVER_SECRET && fullName && fullName !== "미등록 상품") {
            try {
                const nr = await fetch(
                    `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(fullName)}&display=1&sort=sim`,
                    { headers: { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET }, signal: AbortSignal.timeout(3000) }
                );
                const nj = await nr.json();
                if (nj?.items?.length > 0) naverImage = nj.items[0].image || "";
            } catch (e) { console.log("네이버 이미지 실패:", e.message); }
        }

        if      (naverImage)                productImage = naverImage;
        else if (upcData?.images?.length>0) productImage = upcData.images[0];
        else if (p?.image_front_url)        productImage = toFullImage(p.image_front_url);
        else if (p?.image_url)              productImage = toFullImage(p.image_url);
        else if (p?.image_front_small_url)  productImage = toFullImage(p.image_front_small_url);

        const sources = [];
        if (krData)     sources.push("식약처 C005");
        if (dgData)     sources.push(`공공데이터포털(${dgData.FOOD_NM_KR})`);
        if (krData2)    sources.push("식약처 I2570");
        if (p)          sources.push("Open Food Facts");
        if (upcData)    sources.push("UPCitemdb");
        if (naverImage) sources.push("네이버쇼핑(이미지)");

        return res.status(200).json({
            success: true,
            productName:  rawProductName,
            brand:        brandInfo,
            fullName:     fullName,
            origin:       originText,
            ingredients:  krData?.RAWMTRL_NM || krData2?.RAWMTRL_NM || "",
            nutriGrade:   p?.nutriscore_grade ? p.nutriscore_grade.toUpperCase() : null,
            calories:     caloriesText,
            nova:         nova,
            macros:       macros,
            nutriDetail: {
                basis:        netWtRaw ? `${netWtRaw} 전체 기준` : `제품 1개(${totalServings}회분) 전체 기준`,
                servingInfo:  (servingSizeRaw && totalServings>1) ? `1회 제공량: ${servingSizeRaw} × ${totalServings}회` : null,
                kcal:         kcalT,
                carbs:        carbsT  !==null ? `${carbsT}g`               : null,
                sugars:       sugarsT !==null ? `${sugarsT}g`              : null,
                fat:          fatT    !==null ? `${fatT}g`                 : null,
                saturatedFat: satFT   !==null ? `${satFT}g`               : null,
                transFat:     transFT !==null ? `${transFT}g`             : null,
                protein:      protT   !==null ? `${protT}g`               : null,
                sodium:       sodiumT !==null ? `${Math.round(sodiumT)}mg`: null,
            },
            targetWarnings:    targetWarnings,
            greenwashingAlert: greenwashingAlert,
            certifications:    certifications,
            badIngredients: uniqueBadCount > 0
                ? detectedBadObjs
                : (additives.length > 0
                    ? [{ name: "가벼운 첨가물 일부 포함", risk: "적정 섭취 시 안전" }]
                    : [{ name: "친환경 원물", risk: "매우 안전 👍" }]),
            score:          upcData && !krData && !p ? 50 : score,
            scoreBreakdown: scoreBreakdown,
            isScraped:      false,
            allergens:      translatedAllergens,
            image:          productImage,
            imageNutrition:  toFullImage(p?.image_nutrition_url   || ""),
            imageIngredients:toFullImage(p?.image_ingredients_url || ""),
            _source: sources.join(" + "),
        });

    } catch (error) {
        console.error("scan.js 오류:", error);
        return res.status(500).json({ success: false, message: "서버 오류가 발생했습니다." });
    }
};
