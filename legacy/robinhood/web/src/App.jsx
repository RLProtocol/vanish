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
    document.title = route.page === "app" ? "RobinMix · App" : "RobinMix · Private Robinhood Chain";
    if (route.page === "home" && route.section) {
      requestAnimationFrame(() => document.getElementById(route.section)?.scrollIntoView({ behavior: "smooth" }));
    } else {
      window.scrollTo(0, 0);
    }
  }, [route]);

  return (
    <>
      <Nav onApp={route.page === "app"} theme={theme} setTheme={setTheme} />
      {route.page === "app" ? <AppPage /> : <Landing theme={theme} />}
      <Footer />
    </>
  );
}
