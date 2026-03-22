import { ReactNode } from 'react';

export const metadata = {
  title: 'NanoClaw Web',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
