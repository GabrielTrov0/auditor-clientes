import './globals.css';

export const metadata = { title: 'Auditoria de clientes', robots: { index: false, follow: false } };
export default function RootLayout({ children }) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
