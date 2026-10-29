import type { Location, PharmacyRef } from "../../lib/api";
import { directionsUrlFor, mapsViewUrl } from "../../lib/maps";
import { ExternalIcon } from "../ui/icons";
import { LinkButton } from "../ui/primitives";

/**
 * "Get Directions" (and optionally "View on Google Maps") for one pharmacy. Each link is built from that pharmacy's own verified
 * point, or its address when the point is not verified, and opens in a new tab with `noopener noreferrer`. `origin` is only set
 * when the user chose a location; otherwise Google Maps starts from the user's current location. Renders nothing when the pharmacy
 * has no usable destination.
 */
export function DirectionsActions({
  pharmacy,
  origin,
  variant = "directions",
  size = "sm",
  className,
  showView = false,
}: {
  pharmacy: Pick<PharmacyRef, "name" | "address" | "latitude" | "longitude" | "locationVerified">;
  origin: Location | null;
  variant?: "directions" | "primary" | "secondary";
  size?: "sm" | "md";
  className?: string;
  showView?: boolean;
}) {
  const directions = directionsUrlFor(origin, pharmacy);
  if (!directions) return null;
  const view = showView ? mapsViewUrl(pharmacy) : null;
  return (
    <>
      <LinkButton className={className} href={directions} external size={size} variant={variant} aria-label={`Get Directions to ${pharmacy.name}`}>
        Get Directions <ExternalIcon size={14} />
      </LinkButton>
      {view && (
        <LinkButton className={className} href={view} external size={size} variant="secondary" aria-label={`View ${pharmacy.name} on Google Maps`}>
          View on Google Maps <ExternalIcon size={14} />
        </LinkButton>
      )}
    </>
  );
}
