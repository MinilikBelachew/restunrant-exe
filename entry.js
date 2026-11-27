'use strict';

const fs = require('fs');
const path = require('path');

const jscPath = path.join(__dirname, 'main.jsc');
if (fs.existsSync(jscPath)) {
  require('bytenode');
  require('./main.jsc');
} else {
  require('./main.js');
}
