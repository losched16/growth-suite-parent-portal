// Root: redirect to /home (proxy will bounce to /login if no session).

import { redirect } from 'next/navigation';

export default function Root() {
  redirect('/home');
}
