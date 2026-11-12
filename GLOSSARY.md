# Cadence

An online course platform where Students buy Courses and work through their Lessons.

## Language

### People

**Student**:
A person who buys Courses and takes their Lessons.
_Avoid_: Learner

### Buying

**Purchase**:
A Student's payment for one Course, which grants them access to it.
_Avoid_: Order, transaction

**Amount Paid**:
What the Student actually paid for a Purchase, after any discount. Not the Course's list price.
_Avoid_: Price (that is the list price)

**Team Purchase**:
A Purchase of several Seats of one Course, made for a Team.

**Seat**:
One place in a Team Purchase, which grants one person access to the Course.
_Avoid_: Coupon

**Claimed Seat**:
A Seat that someone has redeemed. A Claimed Seat can never be Refunded.

### Refunding

**Refund Request**:
A Student asking for a Refund of a Purchase, or of some or all of the unclaimed Seats of a Team Purchase they made. It can only be made when Refund Eligibility is met, and it always results in a Refund, without human review. A Team Purchase may have several Refund Requests.
_Avoid_: Cancellation, Reversal, Chargeback, Pending Chargeback

**Refund Reason**:
The Student's own explanation for a Refund Request, kept for later analysis. It does not affect the outcome.

**Refund**:
The return of money for a Purchase, which ends access to the Course. A single-seat Purchase is only ever Refunded in full. A Team Purchase is Refunded per unclaimed Seat chosen by its buyer, each returning its share of the Amount Paid.
_Avoid_: Reversal, Chargeback, Cancellation

**Refunded Purchase**:
A Purchase that has been Refunded in full; a Team Purchase becomes one only once every Seat has been Refunded. It stays on record but grants no access, and the Student may buy the Course again as a new Purchase.

**Refund Eligibility**:
The conditions under which a Student may make a Refund Request. For a Purchase: it is inside the Refund Window, less than half the Course's Lessons are completed, and less than two hours of video have been watched. For a Team Purchase: it is inside the Refund Window and only unclaimed Seats are refunded.

**Refund Window**:
The fourteen calendar days after a Purchase during which a Refund Request may be made. The window includes the whole of the fourteenth day, and it applies to a Team Purchase as a whole.
