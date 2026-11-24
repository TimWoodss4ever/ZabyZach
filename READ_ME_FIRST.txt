ZA BY ZACK ERP - CHANGES (built on your teammates' newest zip)

STEP 1 - DATABASE FIRST (Supabase > SQL Editor)
  Open supabase/migrations/202611230001_order_card_details.sql, copy ALL of it,
  paste it into the SQL Editor and click Run. It is safe to run twice.
  (If you upload the website files before doing this, POS card sales and online
  orders will show an error until the SQL is run.)

STEP 2 - WEBSITE FILES (GitHub)
  Unzip this folder. In your repo click Add file > Upload files and drag in the
  src, tests, migration-review and supabase folders. GitHub keeps the folder
  structure and replaces the files with the same names. Click Commit changes.
  Wait 1-2 minutes, then refresh the site (Ctrl+Shift+R).

STEP 3 - TELL YOUR TEAM
   Files in migration-review/ and a few tests were updated to approve these changes
  (and to fix two tests that were already failing). Please have a teammate review them.

WHAT CHANGED
  - POS: pay by Card asks for name + card details; only the card type and last 4 are saved and shown on the receipt
  - Customer checkout: 5-digit ZIP only; card type + last 4 saved with the online order
  - Sales Orders: new "All orders & receipts" tab (search, reprint, jump to returns)
  - Phone boxes on pickup orders and suppliers accept only 10-digit US numbers
  - Number boxes can be cleared and retyped
  - Each browser tab keeps its own login
