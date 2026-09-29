import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Mail, Phone } from "lucide-react";
import { api } from "./lib";

export type Company = { name?: string | null; id?: string | null; address?: string | null; city?: string | null; phone?: string | null; email?: string | null };
let request: Promise<Company> | null = null;
/** The operator's contact and company details (server configuration), loaded once per page load. */
export function useCompany() {
  const [company, setCompany] = useState<Company | null>(null);
  useEffect(() => {
    let live = true;
    request ||= api<{ company: Company }>("/public/config").then((d) => d.company || {}).catch(() => { request = null; return {}; });
    void request.then((c) => live && setCompany(c));
    return () => { live = false; };
  }, []);
  return company;
}
export const displayPhone = (phone: string) => (phone === "+35924920201" ? "02 492 0201" : phone);

/** Contact line shown at the bottom of every page: e-mail, phone and the company behind the service. */
export function SiteContact({ className = "" }: { className?: string }) {
  const company = useCompany();
  if (!company) return null;
  const legal = [company.name, company.id && `ЕИК ${company.id}`, [company.address, company.city].filter(Boolean).join(", ")].filter(Boolean);
  return <div className={`site-contact ${className}`}>
    {company.email && <a href={`mailto:${company.email}`}><Mail size={14} /> {company.email}</a>}
    {company.phone && <a href={`tel:${company.phone}`}><Phone size={14} /> {displayPhone(company.phone)}</a>}
    <Link to="/contact">Контакт</Link>
    {legal.length > 0 && <span>{legal.join(" · ")}</span>}
  </div>;
}
