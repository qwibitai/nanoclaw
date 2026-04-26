import { Link, Route, Routes } from "react-router-dom";
import { GroupList } from "./routes/GroupList.tsx";
import { GroupDetail } from "./routes/GroupDetail.tsx";

export function App() {
  return (
    <div className="page">
      <nav className="nav">
        <Link to="/" className="brand">
          Paraclaw <span className="sub">claws &amp; vaults</span>
        </Link>
        <Link to="/">Agent groups</Link>
        <a
          href="https://github.com/ParachuteComputer/paraclaw/blob/main/docs/parachute-integration.md"
          target="_blank"
          rel="noreferrer"
        >
          Docs
        </a>
      </nav>

      <Routes>
        <Route path="/" element={<GroupList />} />
        <Route path="/groups/:folder" element={<GroupDetail />} />
        <Route path="*" element={<div className="empty">404 — back to <Link to="/">groups</Link>.</div>} />
      </Routes>
    </div>
  );
}
