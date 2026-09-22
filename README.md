privacy focused optimized browser agent extension

please use uv package manager to manage packages and create virtual environments

Development Workflow

This repository uses a strict Issue-Driven Development workflow. To keep our codebase organized and history traceable, all code changes must be tied to an active issue, and direct commits to the main branch are disabled.

Please follow these steps for any new features, bug fixes, or chores:

1. Create an Issue

Before writing any code, open an issue detailing the bug or feature. This serves as the central discussion point and source of truth for the work. 2. Branch from the Issue

Do not branch directly from main in your terminal. Instead, use the GitHub UI:

    Go to your assigned Issue.

    Under the Development section on the right sidebar, click Create a branch.

    Checkout that branch locally to begin your work.

3. Open a Pull Request

Once your work is complete, push your branch and open a Pull Request against main.

⚠️ Critical Requirement: You must link the issue in your PR description using a supported GitHub closing keyword. For example:

    Closes #12 or Fixes #34

4. Pass Status Checks & Merge

We enforce branch protection rules on main. Your Pull Request cannot be merged unless:

    It contains a closing keyword linking it to an open issue. (Our automated GitHub Action will block the merge if this is missing).

    It passes all required reviews and status checks.

Once merged, GitHub will automatically close the linked issue and prompt you to delete the feature branch.
