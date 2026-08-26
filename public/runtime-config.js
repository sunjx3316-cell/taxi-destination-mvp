// Local Node server fallback. Leave blank when CloudBase is enabled.
window.DESTINATION_API_BASE_URL = '';

// CloudBase is the production backend for the passenger/driver handoff.
// The environment ID is public configuration, not a credential. The AMap key
// belongs only in the Cloud Function environment variables.
window.DESTINATION_CLOUDBASE_ENV = 'sunner-wang-d8ght8niaaaea70b7';

// Fill this after the public site is deployed to CloudBase static hosting,
// then run `npm run android:sync` and rebuild the APK. It is the URL encoded
// in the driver's QR code, so passengers can open it on their own phones.
window.DESTINATION_PUBLIC_WEB_URL = 'https://daonaer-sunner-wang-d8ght8niaaaea70b7.webapps.tcloudbase.com';
