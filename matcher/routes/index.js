var express = require('express');
var router = express.Router();
var main = require('../public/javascripts/main.js');

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Express' });
});



module.exports = router;
