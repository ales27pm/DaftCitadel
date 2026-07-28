const path = require('path');

module.exports = {
  dependencies: {
    'daft-citadel-audio': {
      root: __dirname,
      platforms: {
        ios: {
          podspecPath: path.join(__dirname, 'DaftCitadelNative.podspec'),
        },
        android: {
          sourceDir: path.join(__dirname, 'modules/daft-citadel-native/android'),
          packageImportPath: 'import com.daftcitadel.DaftCitadelNativePackage;',
          packageInstance: 'new DaftCitadelNativePackage()',
        },
      },
    },
  },
};
