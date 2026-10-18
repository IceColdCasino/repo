import './buffer-polyfill.js';
import { mount } from "svelte";
import App from "./App.svelte";
// import "./app.css";
import "./style.css";

if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  if (params.get("iosE2eFullGame") === "1") {
    import("./poker/ios-e2e-full-game.ts").then((mod) => {
      mod.installIosE2eFullGameHook();
    });
  }
}

mount(App, { target: document.getElementById("app") });
