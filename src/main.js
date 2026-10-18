// EMCON must be installed before any application module can transmit.
import { emconStartupReady } from './emcon/boot.js';
import { createStandaloneApplication } from './standalone/application.js';
import {
  ApplicationRedirectError,
  describeError,
} from './standalone/errors.js';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

emconStartupReady
  .then(() => application.start())
  .catch((error) => {
    const loaderStatus = document.querySelector(
      '#loading-screen .loader-status',
    );
    if (error instanceof ApplicationRedirectError) {
      loaderStatus.textContent = error.message;
      return;
    }
    console.error("God's Eye View initialization failed:", error);
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  });

export { application };
