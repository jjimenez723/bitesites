<?php
// Pure-PHP check of the counting rules (no WordPress needed):
//   php integrations/wordpress/bitesites-lead-count/tests/lead-count.test.php
// Fixture people are fictional.

define('ABSPATH', '/tmp/');
function add_action() {}
function is_email($e) { return (bool) filter_var($e, FILTER_VALIDATE_EMAIL); }
require dirname(__DIR__) . '/bitesites-lead-count.php';
$r = fn($f,$l,$e,$p) => (object)['first_name'=>$f,'last_name'=>$l,'email'=>$e,'phone'=>$p];
$rows = [
  $r('Ana','Diaz','ana@example.com','(201) 555-0101'),
  $r('Ana','Diaz','ana@example.com','2015550101'),      // same person, repeat
  $r('A.','Diaz','ana@example.com',''),                 // shares email -> same
  $r('Bo','Lee','','+1 201 555 0199'),
  $r('Robert','Lee','bob@example.com','2015550199'),     // shares phone with Bo -> same
  $r('Cy','Test','cy@example.com','2015550111'),         // test row
  $r('Dee','Eve','dee@example.invalid','2015550122'),    // test row
  $r('Eli','Ray','eli@example.com','2015550133'),
];
$ops = array_values(array_filter($rows, fn($x) => !bitesites_lead_count_is_test($x)));
$n = bitesites_lead_count_distinct($ops);
echo "operational=" . count($ops) . " distinct=$n\n";
if (count($ops) !== 6 || $n !== 3) { echo "FAIL\n"; exit(1); }
echo "PASS\n";
if (bitesites_lead_count_valid_date("2026-11-31") || !bitesites_lead_count_valid_date("2026-11-30")) { echo "FAIL dates\n"; exit(1); }
