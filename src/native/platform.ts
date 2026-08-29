import { Capacitor } from '@capacitor/core';

/**
 * Running inside the iOS/iPadOS shell rather than a browser tab.
 *
 * The web build and the app build are the same bundle, so everything native is
 * behind this check: on the web these paths never run and the browser's own
 * file input stays the only way in.
 */
export const isNative = (): boolean => Capacitor.isNativePlatform();
