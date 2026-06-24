# Contributing to Collaborator

Thank you for your interest in contributing! This is a personal, self-hosted project.

## Development Workflow

1. **Create a feature branch** from `main`
   ```bash
   git checkout -b feature/your-feature-name main
   ```

2. **Make your changes** following the project structure

3. **Run tests**
   ```bash
   npm test
   npm run lint
   cd backend && pytest
   ```

4. **Lint your code**
   ```bash
   npm run lint
   ```

5. **Commit with a descriptive message**
   ```bash
   git commit -m "feat: add description of change"
   ```

6. **Push and create a pull request**

## Code Style

- Follow the existing code style
- Use meaningful variable and function names
- Comment complex logic, not obvious code
- Prefer functional components in React

## Testing

All features should include tests:
- Unit tests for utility functions
- Component tests for UI elements
- Integration tests for key user flows
- Backend: pytest for FastAPI endpoints and database operations

## Pull Request Process

1. Update documentation if needed
2. Ensure all tests pass (frontend and backend)
3. Get approval from project owner
4. Squash commits if requested
5. Merge to main

## Questions?

Open an issue for discussion before starting major changes.
