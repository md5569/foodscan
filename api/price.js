module.exports = async (req, res) => {
    const { barcode, productName } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "No Barcode" });

    // Store Configuration
    const encodedName = encodeURIComponent(productName || '');
    const stores = [
        { id: 'naver', name: '네이버 쇼핑', url: productName ? `https://search.shopping.naver.com/search/all?query=${encodedName}` : `https://search.shopping.naver.com/search/all?query=${barcode}` },
        { id: 'coupang', name: '쿠팡', url: productName ? `https://www.coupang.com/np/search?q=${encodedName}` : `https://www.coupang.com/np/search?q=${barcode}` },
        { id: 'amazon', name: 'Amazon', url: `https://www.amazon.com/s?k=${barcode}` },
        { id: 'google', name: 'Google 쇼핑', url: productName ? `https://www.google.com/search?tbm=shop&q=${encodedName}` : `https://www.google.com/search?tbm=shop&q=${barcode}` }
    ];

    try {
        // UPCitemdb API Fetch as primary source for Amazon/Global
        const upcResponse = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
        const upcData = await upcResponse.json().catch(() => null);

        let baselinePrice = null;
        if (upcData && upcData.items && upcData.items.length > 0) {
            const item = upcData.items[0];
            if (item.offers && item.offers.length > 0) {
                baselinePrice = item.offers[0].price;
            }
        }

        // Extremely simplified scraping logic (Fallbacks)
        // Note: Real-time scraping on Vercel is highly volatile. If blocked, we fallback safely.
        async function fetchPrice(url) {
            try {
                const scrapeRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
                if (!scrapeRes.ok) return "접속보안 (클릭)";
                const html = await scrapeRes.text();
                // Naver/Google naive regex match looking for something like 1,200원 or $12.00
                const matched = html.match(/[\d,]{3,}\s*(원)/) || html.match(/\$[\d,]+\.\d{2}/);
                return matched ? matched[0] : "최저가 조회 (클릭)";
            } catch (e) {
                return "상세보기 (클릭)";
            }
        }

        // Parallel fetch for speed
        const [naverPrice, coupangPrice, googlePrice] = await Promise.all([
            productName ? fetchPrice(stores[0].url) : Promise.resolve("검색어 필요"),
            Promise.resolve("로봇차단 (클릭)"), // Coupang strictly blocks Vercel IPs
            productName ? fetchPrice(stores[3].url) : Promise.resolve("검색어 필요")
        ]);

        // Assemble store data
        const storeResults = [
            { id: 'naver', name: '네이버 쇼핑', price: naverPrice, url: stores[0].url },
            { id: 'coupang', name: '쿠팡', price: "최저가 이동 (클릭)", url: stores[1].url },
            { id: 'amazon', name: 'Amazon', price: baselinePrice ? `$${baselinePrice}` : "해외가 조회 (클릭)", url: stores[2].url },
            { id: 'google', name: 'Google 쇼핑', price: googlePrice, url: stores[3].url }
        ];

        res.status(200).json({ success: true, stores: storeResults });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Price API error", fallbackStores: stores });
    }
};
