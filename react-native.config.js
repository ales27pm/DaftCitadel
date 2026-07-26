const path = require('path');

module.exports = {
  dependencies: {
    'daft-citadel-audio': {
      root: __dirname,
      platforms: {
        ios: {
          podspecPath: path.join(__dirname, 'native/collab/CollabNetworkDiagnostics.podspec'),
        },
        android: {
          sourceDir: path.join(__dirname, 'native/collab/android'),
          packageImportPath: 'import com.daftcitadel.collab.CollabNetworkDiagnosticsPackage;',
          packageInstance: 'new CollabNetworkDiagnosticsPackage()',
        },
      },
    },
  },
};
