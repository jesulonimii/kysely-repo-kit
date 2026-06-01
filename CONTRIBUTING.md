# Contributing to Kysely Repo Kit 🤝

Thank you for your interest in contributing to **Kysely Repo Kit**! We welcome and appreciate contributions of all kinds, whether it's filing bug reports, suggesting new features, improving documentation, or writing code.

---

## Code of Conduct

Please be respectful, collaborative, and constructive. We strive to maintain a welcoming, inclusive, and professional community.

---

## Development Setup

Since this project uses [pnpm](https://pnpm.io) for dependency resolution and execution, we recommend installing pnpm on your machine before starting.

### 1. Clone the Repository

```bash
git clone https://github.com/jesulonimii/kysely-repo-builder.git
cd kysely-repo-builder
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Build the Library

To compile the TypeScript files and verify types:

```bash
pnpm run build
```

This compiles files from `src/` into the `dist/` directory, outputting both modern ES Modules (`.js`) and type declarations (`.d.ts`).

---

## Pull Request Guidelines

When submitting a pull request:

1. **Create a Feature Branch**: Branch off from `main` with a clear, descriptive name (e.g., `feat/add-mysql-support` or `fix/soft-delete-where`).
2. **Keep it Focused**: A single PR should address one bug fix or feature enhancement. This makes review faster and more effective.
3. **Format & Type Check**: Ensure your code passes TypeScript type checking by running `pnpm run build` before pushing.
4. **Write Clean Code**: Follow existing patterns, keep files clean, and preserve all relevant inline comments and docstrings.
5. **Update Documentation**: If you're adding new features or changing APIs, make sure to update the `README.md` to reflect those changes.

---

## Reporting Issues

If you find a bug or have a feature request:

- Search the existing Issues to make sure it hasn't already been reported.
- Open a new Issue and provide:
  - A clear, concise title.
  - Steps to reproduce the issue.
  - A minimal code snippet demonstrating the problem.
  - The expected vs. actual behavior.

---

## License

By contributing to this project, you agree that your contributions will be licensed under the MIT License.
