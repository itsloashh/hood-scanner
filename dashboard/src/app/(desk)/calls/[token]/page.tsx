import { redirect } from 'next/navigation';
export default async function Old({ params }: { params: Promise<{ token: string }> }) {
  redirect(`/coins/${(await params).token}`);
}
