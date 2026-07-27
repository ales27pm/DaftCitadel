const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', 'expo', 'virtual', 'streams.js');

if (!fs.existsSync(target)) {
  console.warn('expo virtual streams patch skipped: target file not found');
  process.exit(0);
}

const replacement = `// Patched by scripts/patchExpoVirtualStreams.js.
// Expo 54's generated native Web Streams prelude can be transformed with a
// global require("@babel/runtime/helpers/defineProperty"), which crashes Hermes
// Release before Metro's module require exists. Daft Citadel does not use Expo
// RSC/Web Streams at startup, so keep this virtual module inert for native
// builds.
`;

const current = fs.readFileSync(target, 'utf8');
if (current === replacement) {
  process.exit(0);
}

fs.writeFileSync(target, replacement);
console.log('Patched expo/virtual/streams.js for native Hermes Release startup.');
