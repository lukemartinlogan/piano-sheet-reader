import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The iPad shell.
 *
 * Everything the app needs is inside the bundle: the engraver, the synth, the
 * importers and the example score. There is no server and no `server.url` here
 * on purpose — the WebView loads `capacitor://localhost` from `dist/`, so the
 * app runs identically in airplane mode.
 */
const config: CapacitorConfig = {
  appId: 'com.lukemartinlogan.sheetreader',
  appName: 'Sheet Reader',
  webDir: 'dist',
  ios: {
    // The score scrolls inside its own element; letting WKWebView add its own
    // inset on top of that leaves a dead band under the toolbar.
    contentInset: 'never',
    // Reading music is a dark-room activity and the app is dark throughout.
    backgroundColor: '#12141a',
    // Scrolling is the app's own; the WebView's rubber-band on the outer
    // document just detaches the toolbar from the top of the screen.
    scrollEnabled: false,
  },
  plugins: {
    // No splash delay — the app is local, so it is up in a frame or two.
    SplashScreen: { launchAutoHide: true, launchShowDuration: 0 },
  },
};

export default config;
