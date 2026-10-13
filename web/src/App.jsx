import { useEffect, useState } from "react";
import Landing from "./components/Landing.jsx";
import AppPage from "./components/AppPage.jsx";
import { Footer, Nav, useTheme } from "./components/shared.jsx";

// Routes: "#/app" is the app; "#/<section-id>" scrolls the landing page to that section.
const parse = () => {
  const h = window.location.hash.replace(/^#\/?/, "");
  return h === "app" ? { page: "app" } : { page: "home", section: h || null };
};

export default function App() {
  const [route, setRoute] = useState(parse);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    document.title = route.page === "app" ? "Vanish · App" : "Vanish · Shield, swap and buy privately on Solana";
    if (route.page === "home" && route.section) {
      requestAnimationFrame(() => document.getElementById(route.section)?.scrollIntoView({ behavior: "smooth" }));
    } else {
      window.scrollTo(0, 0);
    }
  }, [route]);

  return (
    <>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          <linearGradient id="sol-grad" gradientUnits="userSpaceOnUse" x1="0" y1="16" x2="11" y2="0">
            <stop offset="0" stopColor="#9945ff" /><stop offset="0.5" stopColor="#5497d5" /><stop offset="1" stopColor="#19fb9b" />
          </linearGradient>
          <linearGradient id="sol-grad-hi" gradientUnits="userSpaceOnUse" x1="0" y1="16" x2="11" y2="0">
            <stop offset="0" stopColor="#b57bff" /><stop offset="0.5" stopColor="#7fb6ea" /><stop offset="1" stopColor="#6dfcc0" />
          </linearGradient>
        </defs>
      </svg>
      <Nav onApp={route.page === "app"} theme={theme} setTheme={setTheme} />
      {route.page === "app" ? <AppPage /> : <Landing theme={theme} />}
      <Footer />
    </>
  );
}
