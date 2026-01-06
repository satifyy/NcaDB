# Security Policy

## Overview

This document outlines the security practices and considerations for the NcaDB repository.

## What Has Been Secured

### 1. Build Artifacts Excluded
- All `dist/` directories are now excluded from version control
- TypeScript build info files (`*.tsbuildinfo`) are excluded
- Build artifacts can be regenerated with `npm run build`

### 2. Log Files Excluded
- All log files (`*.log`) are excluded from version control
- Debug logs like `debug_boxscore.log` and `failed_boxscores.log` are not tracked

### 3. Environment Files Protected
- `.env` files and their variants are excluded from version control
- Currently, this project does not use environment variables
- If you need to add API keys or secrets in the future, use environment variables via `.env` files

### 4. Debug and Temporary Files
- Debug HTML files and temporary files are excluded
- IDE and OS-specific files are ignored

## Security Best Practices

### For Contributors

1. **Never commit secrets**: Do not hardcode API keys, passwords, tokens, or other sensitive data in source code
2. **Use environment variables**: If you need to add authentication or API keys, use environment variables
3. **Keep dependencies updated**: Regularly update npm dependencies to patch security vulnerabilities
4. **Review .gitignore**: Before committing, ensure you're not accidentally tracking sensitive files

### For Maintainers

1. **Code Review**: Review all pull requests for potential security issues
2. **Dependency Audits**: Run `npm audit` regularly to check for known vulnerabilities
3. **Access Control**: Limit repository access to trusted contributors
4. **Secret Scanning**: Enable GitHub's secret scanning feature to detect accidentally committed secrets

## Verified Security Status

✅ No hardcoded secrets found in source code  
✅ No API keys or tokens in the repository  
✅ No private keys or certificates committed  
✅ Build artifacts properly excluded from version control  
✅ Log files properly excluded from version control  
✅ Repository marked as private in package.json  

## Reporting Security Issues

If you discover a security vulnerability in this project, please report it privately to the repository maintainers rather than opening a public issue.

## Safe to Publish

This repository has been reviewed and is safe to publish publicly with the following considerations:

- All build artifacts have been removed from git history
- No secrets or sensitive information are present in the codebase
- Proper `.gitignore` rules are in place to prevent future commits of sensitive files
- The project scrapes publicly available NCAA soccer data and does not handle user authentication or private data

## Future Considerations

If you plan to add features that require authentication or API keys:

1. Create a `.env.example` file with placeholder values
2. Document required environment variables in the README
3. Never commit actual `.env` files with real credentials
4. Consider using a secrets management service for production deployments
