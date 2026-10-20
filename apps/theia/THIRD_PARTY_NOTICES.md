# Third-party notices for the CONTINUUM Theia application

CONTINUUM's Theia application is composed of separately licensed upstream packages. The package manifests in this directory pin the Eclipse Theia packages to 1.76.0. The upstream Eclipse Theia repository identifies its core packages under **EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0**; confirm the exact license metadata for every resolved package in the generated dependency tree before publishing a binary.

- Eclipse Theia source and package metadata: https://github.com/eclipse-theia/theia
- Eclipse Theia extension and application documentation: https://theia-ide.org/docs/
- Theia's license and notices are published upstream in that repository (including LICENSE-EPL, LICENSE-GPL-2.0-ONLY-CLASSPATH-EXCEPTION, and NOTICE.md).
- This application does not copy Theia source files into the CONTINUUM source tree; it consumes Theia packages as dependencies and adds a separate CONTINUUM extension.
- The existing root `LICENSE` governs CONTINUUM-owned materials only. It does not replace or remove rights and obligations that apply to Theia or any transitive dependency.

Before distributing installers publicly, generate and review a complete SBOM/license inventory for the exact lockfile and installer, include applicable upstream license/notice texts in the installer or distribution, and have the distribution terms reviewed. Do not represent the full dependency tree as MIT-only or proprietary-only.
