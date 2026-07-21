const path = require('path');

module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: path.join(__dirname, 'ios/DaftCitadelNative.podspec'),
      },
      android: {
        sourceDir: path.join(__dirname, 'android'),
        packageImportPath: 'import com.daftcitadel.DaftCitadelNativePackage;',
        packageInstance: 'new DaftCitadelNativePackage()',
      },
    },
  },
};
