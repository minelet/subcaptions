const { PACKS } = require('../lib/packs');

module.exports = async (req, res) => {
  res.json({ packs: Object.values(PACKS) });
};
