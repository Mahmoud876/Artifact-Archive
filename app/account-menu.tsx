"use client";

import { useState } from "react";
import { useLocalAuth } from "./auth-gate";

export default function AccountMenu() {
  const { user, signOut } = useLocalAuth();
  const [open, setOpen] = useState(false);
  const initials = user.displayName.trim().split(/\s+/).slice(0, 2)
    .map((part) => part[0]).join("").toUpperCase() || "U";

  return <div className="account-menu">
    <button type="button" className="account-trigger" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-label="Account menu">
      <span className="avatar">{initials}</span>
      <span className="account-trigger-text"><strong>{user.displayName}</strong><small>@{user.username}</small></span>
    </button>
    {open && <div className="account-popover">
      <strong>{user.displayName}</strong>
      <small>@{user.username}</small>
      <button type="button" onClick={() => void signOut()}>Sign out</button>
    </div>}
  </div>;
}
