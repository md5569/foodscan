const fetch = require('node-fetch');

module.exports = async (req, res) => {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "No Barcode" });

    try {
        // Use UPCitemdb free trial API (100 requests / day)
        const response = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
        const data = await response.json();

        // Extract price information if available
        let priceInfo = null;
        if (data && data.items && data.items.length > 0) {
            const item = data.items[0];
            if (item.offers && item.offers.length > 0) {
                const offer = item.offers[0];
                priceInfo = {
                    price: offer.price,
                    currency: offer.currency || "KRW",
                    source: "UPCitemdb"
                };
            }
        }

        if (!priceInfo) {
            // No price found – return success with null price
            return res.status(200).json({ success: true, price: null, message: "Price not found" });
        }

        res.status(200).json({ success: true, ...priceInfo });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Price API error" });
    }
};
