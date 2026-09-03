import { Navbar } from "./components/Navbar";
import { Hero } from "./components/Hero";
import { Features } from "./components/Features";
import { Squad } from "./components/Squad";
import { CliShowcase } from "./components/CliShowcase";
import { Faq } from "./components/Faq";
import { Waitlist } from "./components/Waitlist";
import { Footer } from "./components/Footer";

export function App() {
  const scrollToWaitlist = () => {
    const el = document.getElementById("waitlist");
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <div className="min-h-screen bg-[#ffffff] text-[#09090b] selection:bg-[#ede9fe] selection:text-[#4338ca]">
      {/* Navigation */}
      <Navbar onOpenWaitlist={scrollToWaitlist} />

      {/* Main Content */}
      <main>
        <Hero onOpenWaitlist={scrollToWaitlist} />
        <Features />
        <Squad />
        <CliShowcase />
        <Faq />
        <Waitlist />
      </main>

      {/* Footer */}
      <Footer />
    </div>
  );
}

export default App;
