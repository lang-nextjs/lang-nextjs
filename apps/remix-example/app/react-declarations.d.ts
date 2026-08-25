// Patch @types/react@18.3 ReactPortal to make children optional.
// react-router@6 components return ReactElement | null which is incompatible
// with the @types/react@18.3 ReactPortal type that requires children.
// See: https://github.com/remix-run/remix/issues/7590
import "react";

declare module "react" {
  interface ReactPortal {
    children?: ReactNode;
  }
}
