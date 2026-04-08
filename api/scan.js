// ============================================================
//  scan.js — v11 (제미나이 코드리뷰 반영)
//  ① Promise.all 병렬 처리 (C005 + OFF 동시 호출)
//  ② r.ok 검증 후 JSON 파싱 (HTML 에러 페이지 방지)
//  ③ Node.js 18+ 명시 (vercel.json에서 별도 설정 필요)
//  ④ 공공데이터포털 응답 파싱 버그 수정 (j.response.body.items)
// ============================================================

const FOODSAFETY_KEY = process.env.FOODSAFETY_API_KEY || "0568dde2474141e595f9";
const DATA_GO_KEY    = process.env.DATA_GO_API_KEY    || "1208099b45e4f61f0c9535abe2064f9551e672cf8788c97d99619974caf435f2";
const NAVER_ID       = process.env.NAVER_CLIENT_ID;
const NAVER_SECRET   = process.env.NAVER_CLIENT_SECRET;

// ── 유틸
const parseNum = (v) => {
    if (v == null || v === "") return null;
    const n = parseFloat(String(v));
    return isNaN(n) ? null : n;
};
const parseSize = (s) => {
    if (!s) return null;
    const m = String(s).match(/([\d.]+)\s*(g|ml)/i);
    return m ? parseFloat(m[1]) : (String(s).match(/^[\d.]+$/) ? parseFloat(s) : null);
};
const toFull = (url) => {
    if (!url) return "";
    return url.replace(/\.(\d+)\.jpg$/i, ".full.jpg").replace(/\.small\.jpg$/i, ".full.jpg");
};

// ② r.ok 검증 포함 안전 fetch 래퍼
async function safeFetch(url, options = {}) {
    const r = await fetch(url, options);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
    return r.json();
}

// ── 영한 브랜드 대조표
const BRAND_EN_KO = {
    "paldo":"팔도","nongshim":"농심","ottogi":"오뚜기","samyang":"삼양",
    "lotte":"롯데","orion":"오리온","haitai":"해태","dongwon":"동원",
    "cj":"씨제이","pulmuone":"풀무원","daesang":"대상","bingrae":"빙그레",
    "crown":"크라운","maeil":"매일","namyang":"남양","woongjin":"웅진",
};

// ── 영한 제품명 대조표 (대폭 확장)
const PROD_EN_KO = {
    // 라면
    "dosirak":"도시락","shin ramyun":"신라면","shin ramen":"신라면",
    "buldak":"불닭","chapagetti":"짜파게티","neoguri":"너구리",
    "yukgaejang":"육개장","jin ramen":"진라면","bibim men":"비빔면",
    "ansung tang myun":"안성탕면","kokomen":"꼬꼬면",
    "samyang ramen":"삼양라면","ramyun":"라면","ramen":"라면",
    // 음료/유제품
    "banana milk":"바나나맛우유","banana flavored milk":"바나나맛우유",
    "strawberry milk":"딸기맛우유","chocolate milk":"초코우유",
    "milkis":"밀키스","cider":"사이다","cola":"콜라",
    "sikhye":"식혜","banana":"바나나","barista":"바리스타",
    // 과자/스낵
    "honey butter":"허니버터","choco pie":"초코파이",
    "pepero":"빼빼로","homerun ball":"홈런볼","binch":"빈츠",
    "jolly pong":"조리퐁","popcorn":"팝콘","chips":"칩스",
    "cracker":"크래커","biscuit":"비스킷","cookie":"쿠키",
    // 기타
    "green tea":"녹차","red bean":"팥","sesame":"참깨",
    "kimchi":"김치","tuna":"참치","seaweed":"미역",
    "gochujang":"고추장","doenjang":"된장","soy sauce":"간장",
    "spaghetti":"스파게티","pasta":"파스타","noodle":"국수",
};

function toKoName(name, brand) {
    const nl = (name||"").toLowerCase();
    for (const [en,ko] of Object.entries(PROD_EN_KO)) if (nl.includes(en)) return ko;
    const bl = (brand||"").toLowerCase();
    return BRAND_EN_KO[bl] || null;
}

// ④ 공공데이터포털 items 안전 추출
function extractDgItems(j) {
    let items =
        j?.response?.body?.items ||  // ← 표준 구조
        j?.body?.items           ||
        j?.items                 || [];
    if (items && !Array.isArray(items)) items = [items]; // 단건 → 배열
    return Array.isArray(items) ? items : [];
}

module.exports = async (req, res) => {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success:false, message:"No Barcode" });

    try {
        // ══════════════════════════════════════════════════════
        //  ① Promise.all로 C005 + OFF 병렬 호출
        //     독립적인 두 API를 동시에 요청 → 최대 4초 절감
        // ══════════════════════════════════════════════════════
        const [krResult, offResult] = await Promise.allSettled([
            safeFetch(
                `http://openapi.foodsafetykorea.go.kr/api/${FOODSAFETY_KEY}/C005/json/1/5/BAR_CD=${barcode}`,
                { signal: AbortSignal.timeout(4000) }
            ),
            safeFetch(
                `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`,
                { signal: AbortSignal.timeout(4000) }
            ),
        ]);

        const kr = krResult.status === "fulfilled" && krResult.value?.C005?.row?.length > 0
            ? krResult.value.C005.row[0] : null;
        const p  = offResult.status === "fulfilled" && offResult.value?.status === 1
            ? offResult.value.product : null;

        if (krResult.status === "rejected") console.log("C005:", krResult.reason?.message);
        if (offResult.status === "rejected") console.log("OFF:", offResult.reason?.message);

        // UPCitemdb — C005+OFF 둘 다 없을 때만
        let upc = null;
        if (!kr && !p) {
            try {
                const j = await safeFetch(
                    `https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`,
                    { signal: AbortSignal.timeout(4000) }
                );
                if (j?.items?.length > 0) upc = j.items[0];
            } catch(e) { console.log("UPC:", e.message); }
        }

        if (!kr && !p && !upc)
            return res.status(200).json({ success:false, message:"모든 DB에서 찾을 수 없는 상품입니다 🥲" });

        // ── 기본 정보
        const rawName  = kr?.PRDLST_NM || p?.product_name_ko || p?.product_name || upc?.title || "미등록 상품";
        const brand    = kr?.BSSH_NM   || p?.brands          || upc?.brand      || "";
        const fullName = (brand && !rawName.includes(brand)) ? `${brand} ${rawName}`.trim() : rawName;

        const isEng  = /^[a-zA-Z\s\-_0-9]+$/.test(rawName.trim());
        const koName = kr      ? rawName
                     : isEng  ? (toKoName(rawName, brand) || null)
                     : rawName.replace(/[a-zA-Z]/g,"").trim() || rawName;

        // 원산지 / 원재료
        let origin = "제품 라벨 확인 필요";
        if (kr?.ORPLC_INFO?.trim())                             origin = kr.ORPLC_INFO.trim();
        else if (p?.origins?.trim())                            origin = p.origins.trim();
        else if (p?.countries_tags?.includes("en:south-korea")) origin = "국산 (제조국 기준)";

        let ingredients = "";
        if (kr?.RAWMTRL_NM?.trim()) ingredients = kr.RAWMTRL_NM.trim().toLowerCase();
        else if (p) ingredients = (p.ingredients_text_ko || p.ingredients_text || "").toLowerCase();

        // ── 브랜드 한글화
        const brandKo    = BRAND_EN_KO[(brand||"").toLowerCase().trim()] || "";
        const brandClean = brandKo.replace(/[㈜(주)\s]/g,"").trim();

        // ══════════════════════════════════════════════════════
        //  공공데이터포털 영양성분 (④ 파싱 버그 수정)
        // ══════════════════════════════════════════════════════
        let dg = null;
        const dgQueries = [...new Set([
            brandClean && koName ? `${brandClean} ${koName}` : null,
            koName,
            brandClean || null,
        ].filter(Boolean))];

        for (const q of dgQueries) {
            if (dg) break;
            try {
                const j = await safeFetch(
                    `https://apis.data.go.kr/1471000/FoodNtrIrdntInfoService1/getFoodNtrItdntList1`+
                    `?serviceKey=${DATA_GO_KEY}&pageNo=1&numOfRows=10&type=json`+
                    `&FOOD_NM_KR=${encodeURIComponent(q)}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                const items = extractDgItems(j);
                if (items.length > 0) {
                    let best = null, score = -1;
                    for (const item of items) {
                        const nm = (item.FOOD_NM_KR||"").toLowerCase();
                        const mk = (item.MAKER_NM||"").toLowerCase();
                        let s = 0;
                        if (koName     && nm.includes(koName.toLowerCase()))     s += 3;
                        if (brandClean && mk.includes(brandClean.toLowerCase())) s += 2;
                        if (brandClean && nm.includes(brandClean.toLowerCase())) s += 1;
                        if (s > score) { score = s; best = item; }
                    }
                    if (score > 0) {
                        dg = best;
                        console.log(`dg(${score}): ${dg.FOOD_NM_KR} / ${dg.MAKER_NM}`);
                    }
                }
            } catch(e) { console.log(`dg(${q}):`, e.message); }
        }

        // I2570 — C005+dg 없을 때만
        let kr2 = null;
        if (!kr && !dg && koName) {
            try {
                const j = await safeFetch(
                    `http://openapi.foodsafetykorea.go.kr/api/${FOODSAFETY_KEY}/I2570/json/1/10/PRDLST_NM=${encodeURIComponent(koName)}`,
                    { signal: AbortSignal.timeout(4000) }
                );
                if (j?.I2570?.row?.length > 0) {
                    kr2 = j.I2570.row.find(r => r.PRDLST_NM?.includes(koName)) || j.I2570.row[0];
                }
            } catch(e) { console.log("I2570:", e.message); }
        }

        // ── 영양성분 계산
        //  C005/I2570: CONT1=열량 CONT2=탄수 CONT3=당류 CONT4=지방
        //              CONT5=트랜스 CONT6=포화 CONT8=단백 CONT9=나트륨(mg)
        //  data.go.kr: CONT1=열량 CONT3=단백 CONT4=지방 CONT5=탄수
        //              CONT6=당류★ CONT12=나트륨★(mg) CONT22=포화 CONT23=트랜스
        const svRaw = kr?.SERVING_SIZE || dg?.SERVING_SIZE || kr2?.SERVING_SIZE || p?.serving_size || null;
        const svG   = parseSize(svRaw);
        const ntRaw = kr?.NET_WT || p?.quantity || null;
        const ntG   = parseSize(ntRaw) || null;
        let total   = parseNum(kr?.SERVING_TOTAL) || null;
        if (!total && svG && ntG && ntG > svG) total = Math.round(ntG / svG);
        if (!total) total = 1;

        const n = p?.nutriments || {};
        // ✅ svG 없어도 100g 기준값 그대로 사용 (총량 환산 포기하고 정보라도 표시)
        const offSv = (k100, ksv) => {
            if (n[ksv]  != null) return n[ksv];                          // 1회제공량 기준 직접값
            if (n[k100] != null && svG) return n[k100] * svG / 100;     // 100g→1회 환산
            if (n[k100] != null) return n[k100];                         // ✅ svG 없으면 100g값 그대로
            return null;
        };

        const kcalPS = parseNum(kr?.NUTR_CONT1)  ?? parseNum(dg?.NUTR_CONT1)  ?? parseNum(kr2?.NUTR_CONT1) ?? offSv("energy-kcal_100g","energy-kcal_serving");
        const carbPS = parseNum(kr?.NUTR_CONT2)  ?? parseNum(dg?.NUTR_CONT5)  ?? parseNum(kr2?.NUTR_CONT2) ?? offSv("carbohydrates_100g","carbohydrates_serving");
        const sugPS  = parseNum(kr?.NUTR_CONT3)  ?? parseNum(dg?.NUTR_CONT6)  ?? parseNum(kr2?.NUTR_CONT3) ?? offSv("sugars_100g","sugars_serving");
        const fatPS  = parseNum(kr?.NUTR_CONT4)  ?? parseNum(dg?.NUTR_CONT4)  ?? parseNum(kr2?.NUTR_CONT4) ?? offSv("fat_100g","fat_serving");
        const trnPS  = parseNum(kr?.NUTR_CONT5)  ?? parseNum(dg?.NUTR_CONT23) ?? offSv("trans-fat_100g","trans-fat_serving");
        const satPS  = parseNum(kr?.NUTR_CONT6)  ?? parseNum(dg?.NUTR_CONT22) ?? offSv("saturated-fat_100g","saturated-fat_serving");
        const proPS  = parseNum(kr?.NUTR_CONT8)  ?? parseNum(dg?.NUTR_CONT3)  ?? parseNum(kr2?.NUTR_CONT8) ?? offSv("proteins_100g","proteins_serving");
        const sodPS  = parseNum(kr?.NUTR_CONT9)  ?? parseNum(dg?.NUTR_CONT12) ?? parseNum(kr2?.NUTR_CONT9) ??
            (n.sodium_serving != null ? n.sodium_serving * 1000 :
             n.sodium_100g    != null && svG ? n.sodium_100g * 1000 * svG / 100 : null);

        const tt = (v) => v !== null ? Math.round(v * total * 10) / 10 : null;
        const kcalT=tt(kcalPS), carbT=tt(carbPS), sugT=tt(sugPS), fatT=tt(fatPS);
        const trnT=tt(trnPS),   satT=tt(satPS),   proT=tt(proPS), sodT=tt(sodPS);

        let calText = "열량 정보 없음 (비공개)";
        if (kcalT !== null) {
            const base = ntRaw ? `${ntRaw} 전체` : `제품 1개 전체`;
            const sv   = (kcalPS !== null && total > 1) ? ` (1회 ${svRaw}: ${Math.round(kcalPS)}kcal × ${total}회)` : "";
            calText = `${base}: ${kcalT}kcal${sv}`;
        }

        // ── 유해성분
        const WD = {
            "설탕":          {name:"설탕",                   risk:"과다 섭취 시 만성 염증·비만·간 손상 위험 ⚠️"},
            "sugar":         {name:"설탕",                   risk:"혈당 급상승 및 대사 증후군 유발 ⚠️"},
            "과당":          {name:"액상과당(콘시럽)",        risk:"설탕보다 흡수 빨라 체지방(지방간) 축적 주범 🔴"},
            "물엿":          {name:"물엿/단당류",             risk:"혈당 급상승 ⚠️"},
            "수크랄로스":    {name:"수크랄로스",             risk:"인공 감미료: 장내 유익균 파괴·인슐린 저항성 악화 🔴"},
            "아스파탐":      {name:"아스파탐",               risk:"인공 감미료: WHO 발암가능물질·신경계 교란 🔴"},
            "사카린":        {name:"사카린나트륨",           risk:"인공 감미료: 장기 섭취 시 소화기 부작용 ⚠️"},
            "아세설팜칼륨":  {name:"아세설팜칼륨",           risk:"인공 감미료: 갑상선 기능 영향 우려 ⚠️"},
            "팜유":          {name:"팜유",                   risk:"포화지방 과다 → LDL 콜레스테롤 상승 ⚠️"},
            "palm oil":      {name:"팜유",                   risk:"포화지방 과다 ⚠️"},
            "마가린":        {name:"마가린",                 risk:"트랜스지방 함유 → 혈관 벽 손상 🔴"},
            "쇼트닝":        {name:"쇼트닝",                 risk:"트랜스지방 함유 → 혈관 벽 손상 🔴"},
            "소르빈산":      {name:"소르빈산염",             risk:"보존료: 피부 점막 자극·알레르기 유발 ⚠️"},
            "아질산나트륨":  {name:"아질산나트륨",           risk:"발색제: 1급 발암물질(니트로사민) 생성 위험 🔴"},
            "안식향산나트륨":{name:"안식향산나트륨",         risk:"보존료: 벤젠(1급 발암) 생성 위험 🔴"},
            "글루탐산나트륨":{name:"MSG",                    risk:"향미증진제: 민감 체질 두통·발진 유발 ⚠️"},
            "합성향료":      {name:"합성향료",               risk:"미확인 화학물질: 알레르기·두통 원인 ⚠️"},
            "타르색소":      {name:"타르색소",               risk:"인공 착색료: 아동 ADHD 촉발 의심 🔴"},
            "카라멜색소":    {name:"카라멜색소",             risk:"4-MEI 발암물질 포함 가능성 ⚠️"},
        };
        const bads = [];
        Object.keys(WD).forEach(k => {
            if (ingredients.includes(k) && !bads.some(b=>b.name===WD[k].name)) bads.push(WD[k]);
        });
        const badCnt   = bads.length;
        const additives = p?.additives_tags || [];

        // ── 알레르기
        const KA = [
            {keys:["우유","탈지분유","전지분유","유청","버터","치즈","크림"], label:"우유 (유제품)"},
            {keys:["대두","두유","콩"],                                        label:"대두(콩)"},
            {keys:["밀","소맥분","글루텐","빵가루"],                           label:"밀 (글루텐)"},
            {keys:["달걀","계란","난백","난황"],                               label:"달걀"},
            {keys:["땅콩","피넛"],                                              label:"땅콩 (🔴 쇼크 위험)"},
            {keys:["새우","건새우"],                                            label:"새우 (갑각류 🔴)"},
            {keys:["게","꽃게"],                                                label:"게 (갑각류 🔴)"},
            {keys:["고등어"],                                                   label:"고등어"},
            {keys:["복숭아"],                                                   label:"복숭아"},
            {keys:["토마토"],                                                   label:"토마토"},
            {keys:["아황산","이산화황"],                                        label:"아황산염 (🔴 천식)"},
            {keys:["호두"],                                                     label:"호두"},
            {keys:["아몬드"],                                                   label:"아몬드"},
            {keys:["참깨","참기름"],                                            label:"참깨"},
            {keys:["돼지고기","돈육","돈지"],                                   label:"돼지고기"},
            {keys:["소고기","우육","쇠고기"],                                   label:"소고기"},
            {keys:["닭고기","계육"],                                            label:"닭고기"},
            {keys:["오징어"],                                                   label:"오징어"},
            {keys:["조개","굴","홍합","전복"],                                  label:"조개류"},
        ];
        const AD = {
            "milk":"우유","soybeans":"대두","wheat":"밀","eggs":"달걀",
            "peanuts":"땅콩 (🔴 쇼크 위험)","fish":"생선","crustaceans":"갑각류 (🔴)",
            "tree nuts":"견과류","sesame":"참깨","sulphites":"아황산염 (🔴 천식)",
            "molluscs":"연체동물","gluten":"글루텐","soy":"콩","pork":"돼지고기","beef":"소고기"
        };
        const krAll = [];
        KA.forEach(({keys,label}) => {
            if (keys.some(k=>ingredients.includes(k)) && !krAll.includes(label)) krAll.push(label);
        });
        let offAll = [];
        if (p?.allergens_tags?.length > 0) {
            offAll = p.allergens_tags.map(t => AD[t.replace(/en:|fr:|ko:/g,"").toLowerCase()] || t.replace(/en:|fr:|ko:/g,"").toLowerCase());
        } else if (p?.allergens_from_ingredients) {
            let raw = p.allergens_from_ingredients.replace(/en:/g,"").toLowerCase();
            Object.keys(AD).forEach(e => { raw = raw.replace(new RegExp(`\\b${e}\\b`,"gi"), AD[e]); });
            if (raw.trim()) offAll = raw.split(",").map(s=>s.trim()).filter(Boolean);
        }
        const allergens = [...new Set([...krAll,...offAll])];
        if (!allergens.length) allergens.push("없음");

        // ── 점수
        let score = 100;
        const breakdown = [];
        if (additives.length > 0) { const d=Math.min(additives.length*5,40); breakdown.push(`화학 첨가물 ${additives.length}개 (-${d}점)`); score-=d; }
        if (badCnt > 0)           { const d=badCnt*10; breakdown.push(`유해성분 ${badCnt}개 (-${d}점)`); score-=d; }
        score = Math.max(10, score);

        // ── K-FDA 위험도
        const kfda = (v, lim, name) => {
            if (v === null) return {value:"?", level:"unknown", text:"정보 없음", emoji:"⚪"};
            const pct = Math.round((v/lim)*100);
            let l="green", t=`1일 권장량의 ${pct}% (안전)`, e="🟢";
            if (pct >= 50)      { l="red";   t=`1일 권장량의 ${pct}% ⚠️ 위험`; e="🔴"; }
            else if (pct >= 25) { l="amber"; t=`1일 권장량의 ${pct}% 주의`;     e="🟡"; }
            return { value: name==="나트륨" ? `${Math.round(v)}mg` : `${Math.round(v*10)/10}g`, level:l, text:t, emoji:e };
        };

        // ── 타겟 경고
        const warns = [];
        if ((sugT!==null && sugT>25) || Object.keys(WD).some(w=>ingredients.includes(w)&&["비만","혈당","당","상승"].some(r=>WD[w].risk.includes(r))))
            warns.push("🩸 당뇨/혈당 스파이크 경고");
        if (sodT!==null && sodT>1000)
            warns.push("🫀 심혈관/고혈압 주의 (나트륨 1일 권장량 50% 초과)");
        if (Object.keys(WD).some(w=>ingredients.includes(w)&&["발암","ADHD","벤젠","색소"].some(r=>WD[w].risk.includes(r)))||ingredients.includes("카페인"))
            warns.push("👶 영유아/임산부 섭취 제한 요망");

        // ── 그린워싱
        let gw = null;
        if (["제로","zero","라이트","light","무가당","슈가프리","천연","내추럴","natural"].some(k=>fullName.toLowerCase().includes(k)) && badCnt>0)
            gw = "🚨 [그린워싱] 마케팅은 '제로/천연'이나 실제 유해성분이 발견되었습니다.";

        // ── 인증
        const certs = [];
        if (kr?.PRDLST_REPORT_NO || kr2?.PRDLST_REPORT_NO) certs.push("🛡️ 식약처 등록 제품");
        const allTxt = (fullName+ingredients+(p?.labels_tags||[]).join(" ")).toLowerCase();
        if (allTxt.includes("haccp")||allTxt.includes("해썹")) certs.push("식약처 HACCP 인증");
        if (allTxt.includes("유기농")||allTxt.includes("organic")) certs.push("유기농 인증 🌱");

        // ── NOVA
        const ND = {1:"자연 원재료 (건강식 🟢)",2:"기본 가공 (보통 🟡)",3:"가공식품 (주의 🟠)",4:"초가공식품 (위험 🔴)"};
        function estimateNova(cat, ing) {
            cat=(cat||"").toLowerCase(); ing=(ing||"").toLowerCase();
            if (["신선","생과일","냉동과일","냉동채소"].some(k=>cat.includes(k))) return 1;
            if (["과자","라면","탄산음료","아이스크림","햄","소시지","스낵","캔디","초콜릿","비스킷"].some(k=>cat.includes(k))
                ||["합성향료","타르색소","아질산","수크랄로스","아스파탐","쇼트닝"].some(k=>ing.includes(k))) return 4;
            if (["음료","빵","면류","통조림","소스","드레싱","잼","요구르트","두부","김치"].some(k=>cat.includes(k))) return 3;
            return 3;
        }
        const ng = p?.nova_group || estimateNova(kr?.PRDLST_DCNM||kr2?.PRDLST_DCNM, ingredients);
        const novaStr = `NOVA ${ng} - ${ND[ng]}${p?.nova_group ? "" : " (추정)"}`;

        // ── 이미지 (네이버 우선 → UPCitemdb → OFF)
        let img = "";
        if (NAVER_ID && NAVER_SECRET) {
            const nQueries = [...new Set([
                brandClean && koName ? `${brandClean} ${koName}` : null,
                koName,
                brandClean || null,
            ].filter(Boolean))];
            for (const q of nQueries) {
                if (img) break;
                try {
                    const j = await safeFetch(
                        `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(q)}&display=3&sort=sim`,
                        { headers:{"X-Naver-Client-Id":NAVER_ID,"X-Naver-Client-Secret":NAVER_SECRET}, signal:AbortSignal.timeout(3000) }
                    );
                    if (j?.items?.length > 0) {
                        const best = j.items.find(i => koName && i.title.replace(/<[^>]+>/g,"").includes(koName)) || j.items[0];
                        img = best.image || "";
                        if (img) console.log(`네이버 이미지(${q})`);
                    }
                } catch(e) { console.log(`naver(${q}):`, e.message); }
            }
        }
        if (!img && upc?.images?.length > 0) img = upc.images[0];
        if (!img) img = toFull(p?.image_front_url || p?.image_url || p?.image_front_small_url || "");

        // ── 출처
        const src = [
            kr  && "식약처 C005",
            dg  && `공공데이터포털(${dg.FOOD_NM_KR})`,
            kr2 && "식약처 I2570",
            p   && "Open Food Facts",
            upc && "UPCitemdb",
            img.includes("pstatic") && "네이버쇼핑(이미지)",
        ].filter(Boolean).join(" + ");

        return res.status(200).json({
            success: true,
            productName: rawName,
            brand, fullName, origin,
            ingredients: kr?.RAWMTRL_NM || kr2?.RAWMTRL_NM || "",
            nutriGrade: (()=>{ const g=p?.nutriscore_grade?.toUpperCase(); return g&&["A","B","C","D","E"].includes(g)?g:null; })(),
            calories: calText,
            nova: novaStr,
            macros: {
                fat:    kfda(fatT,  54,   "지방"),
                sugars: kfda(sugT,  100,  "당류"),
                sodium: kfda(sodT,  2000, "나트륨"),
            },
            nutriDetail: {
                basis:       ntRaw ? `${ntRaw} 전체 기준` : `제품 1개(${total}회분) 기준`,
                servingInfo: (svRaw && total>1) ? `1회 ${svRaw} × ${total}회` : null,
                kcal:        kcalT,
                carbs:       carbT!==null?`${carbT}g` :null,
                sugars:      sugT !==null?`${sugT}g`  :null,
                fat:         fatT !==null?`${fatT}g`  :null,
                saturatedFat:satT !==null?`${satT}g`  :null,
                transFat:    trnT !==null?`${trnT}g`  :null,
                protein:     proT !==null?`${proT}g`  :null,
                sodium:      sodT !==null?`${Math.round(sodT)}mg`:null,
            },
            targetWarnings:    warns,
            greenwashingAlert: gw,
            certifications:    certs,
            badIngredients: badCnt > 0 ? bads
                           : additives.length > 0 ? [{name:"가벼운 첨가물 포함", risk:"적정 섭취 시 안전"}]
                           : [{name:"친환경 원물", risk:"매우 안전 👍"}],
            score,
            scoreBreakdown: breakdown,
            isScraped: false,
            allergens,
            image:           img,
            imageNutrition:  toFull(p?.image_nutrition_url   || ""),
            imageIngredients:toFull(p?.image_ingredients_url || ""),
            _source: src,
        });

    } catch(e) {
        console.error("scan.js 오류:", e);
        return res.status(500).json({ success:false, message:"서버 오류가 발생했습니다." });
    }
};
