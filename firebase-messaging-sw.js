importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");
 
firebase.initializeApp({
  apiKey: "AIzaSyAl_gMgQoZa6F-tInkoc61AA8ggzMhlRPY",
  authDomain: "saludar-b565d.firebaseapp.com",
  projectId: "saludar-b565d",
  storageBucket: "saludar-b565d.firebasestorage.app",
  messagingSenderId: "72976839510",
  appId: "1:72976839510:web:1c08a90e3730748e03dcf7"
});
 
const messaging = firebase.messaging();
 
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "SaludAR";
  const options = {
    body: payload.notification?.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  };
  self.registration.showNotification(title, options);
});
 
