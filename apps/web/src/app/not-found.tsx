import { SearchIcon } from "../components/ui/icons";
import { EmptyState, LinkButton } from "../components/ui/primitives";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg pt-10">
      <EmptyState level={1} icon={<SearchIcon />} title="We couldn't find that page" action={<LinkButton href="/search" variant="primary">Search for a medicine</LinkButton>}>
        The link may be old, or the pharmacy may no longer be listed.
      </EmptyState>
    </div>
  );
}
