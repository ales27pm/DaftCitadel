const path = require('path');

module.exports = {
  dependencies: {
    'daft-citadel-collab': {
      root: __dirname,
      platforms: {
        ios: {
          podspecPath: path.join(__dirname, 'native/collab/CollabNetworkDiagnostics.podspec'),
        },
        android: {
          sourceDir: path.join(__dirname, 'native/collab/android'),
          packageImportPath: 'com.daftcitadel.collab.CollabNetworkDiagnosticsPackage',
          packageInstance: 'new CollabNetworkDiagnosticsPackage()',
        },
      },
    },
  },
};
