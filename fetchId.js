const axios = require('axios');

(async () => {
  const response = await axios.get('https://api.coingecko.com/api/v3/coins/list');
  const matches = response.data.filter(c => c.symbol === 'usdc' || c.name.toLowerCase().includes('usd coin'));
  console.log(matches);
})();
