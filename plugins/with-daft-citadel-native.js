const { withMainApplication } = require('expo/config-plugins');

const PACKAGE_EXPRESSION = 'add(com.daftcitadel.DaftCitadelNativePackage())';

module.exports = function withDaftCitadelNative(config) {
  return withMainApplication(config, (applicationConfig) => {
    if (applicationConfig.modResults.language !== 'kt') {
      throw new Error(
        'Daft Citadel native package registration requires a Kotlin MainApplication.',
      );
    }

    const contents = applicationConfig.modResults.contents;
    if (contents.includes(PACKAGE_EXPRESSION)) {
      return applicationConfig;
    }

    const packageListAnchor = 'PackageList(this).packages.apply {';
    if (!contents.includes(packageListAnchor)) {
      throw new Error(
        'Unable to locate the React Native package list in MainApplication.kt.',
      );
    }

    applicationConfig.modResults.contents = contents.replace(
      packageListAnchor,
      `${packageListAnchor}\n              ${PACKAGE_EXPRESSION}`,
    );
    return applicationConfig;
  });
};
